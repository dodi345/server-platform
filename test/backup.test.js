// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleRequest } from "../lib/agent.js";
import {
  BackupError,
  normalizeEndpoint,
  objectKey,
  readBackupState,
  restoreBackup,
  runBackup,
  verifyBackup,
  writeBackupConfig,
} from "../lib/backup.js";
import { BackupKeyError, decryptFile, encryptFile, generateBackupKeys, parsePrivateKey } from "../lib/backup-crypto.js";
import { main } from "../lib/cli.js";
import { deploy } from "../lib/deploy.js";
import { parseManifest } from "../lib/manifest.js";
import { appPaths } from "../lib/registry.js";
import { _isoWeek, backupTime, DEFAULT_RETENTION, planRetention } from "../lib/retention.js";
import { createS3, S3Error, signV4 } from "../lib/s3.js";
import { createTestEnv, fakeSystem, makeArchive, NODE_FILES, nodeManifest } from "./helpers.js";

const DAY = 86_400_000;
const SECRET = "rahasiaR2rahasiaR2rahasiaR2xx";

/** R2 palsu di memori (antarmuka S3Client). */
function fakeS3(/** @type {{ failDelete?: boolean }} */ opts = {}) {
  /** @type {Map<string, Buffer>} */
  const objects = new Map();
  /** @type {string[]} */
  const calls = [];
  return {
    objects,
    calls,
    async putObject(/** @type {string} */ key, /** @type {Buffer} */ body) {
      calls.push(`put ${key}`);
      objects.set(key, Buffer.from(body));
    },
    async getObject(/** @type {string} */ key) {
      calls.push(`get ${key}`);
      const body = objects.get(key);
      if (!body) throw new S3Error("NoSuchKey", 404, "NoSuchKey");
      return body;
    },
    async deleteObject(/** @type {string} */ key) {
      calls.push(`delete ${key}`);
      if (opts.failDelete) throw new S3Error("R2 menolak DELETE (403 AccessDenied): object locked", 403, "AccessDenied");
      objects.delete(key);
    },
    async listObjects(/** @type {string} */ prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.length, lastModified: "" }));
    },
    async createBucket() {},
  };
}

/** @type {ReturnType<typeof createTestEnv>} */
let env;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

/**
 * App terdaftar + ter-deploy dengan field backup, database SQLite (WAL, koneksi tetap terbuka
 * seperti app yang sedang jalan), folder uploads, dan .env.
 */
async function setupApp(name = "words") {
  await main(["register", name], { paths: env.paths, sys: fakeSystem().sys });
  const app = appPaths(env.paths, name);
  fs.writeFileSync(app.env, "TOKEN=rahasia-app\n");
  const archive = makeArchive(env.root, nodeManifest(name, { backup: ["data/app.db", "data/uploads"] }), NODE_FILES);
  await deploy({ paths: env.paths, sys: fakeSystem().sys, name, sha: "abcdef1234", archive, stableMs: 0 });
  fs.mkdirSync(path.join(app.shared, "data", "uploads"), { recursive: true });
  fs.writeFileSync(path.join(app.shared, "data", "uploads", "foto.txt"), "isi foto");
  const db = new DatabaseSync(path.join(app.shared, "data", "app.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE kata (teks TEXT); INSERT INTO kata VALUES ('halo'), ('dunia');");
  return { app, db };
}

function configure(keys = generateBackupKeys(), extra = {}) {
  writeBackupConfig(env.paths, {
    endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    bucket: "backup",
    accessKeyId: "AKIA0123456789ABCDEF",
    secretAccessKey: SECRET,
    region: "auto",
    publicKey: keys.publicKey,
    includeEnv: true,
    retention: DEFAULT_RETENTION,
    ...extra,
  });
  return keys;
}

describe("enkripsi backup", () => {
  it("bolak-balik; kunci salah atau file diubah → gagal tanpa hasil setengah jadi", async () => {
    const keys = generateBackupKeys();
    assert.match(keys.publicKey, /^spb-pub-[A-Za-z0-9_-]{43}$/);
    assert.equal(parsePrivateKey(keys.privateKey).publicKey, keys.publicKey);
    const src = path.join(env.root, "a.bin");
    fs.writeFileSync(src, Buffer.alloc(200_000, 3));
    await encryptFile(src, `${src}.spb`, keys.publicKey);
    await decryptFile(`${src}.spb`, path.join(env.root, "b.bin"), keys.privateKey);
    assert.ok(fs.readFileSync(src).equals(fs.readFileSync(path.join(env.root, "b.bin"))));

    await assert.rejects(decryptFile(`${src}.spb`, path.join(env.root, "c.bin"), generateBackupKeys().privateKey), BackupKeyError);
    assert.equal(fs.existsSync(path.join(env.root, "c.bin")), false);
    const tampered = fs.readFileSync(`${src}.spb`);
    tampered[1000] = (tampered[1000] ?? 0) ^ 1;
    fs.writeFileSync(`${src}.spb`, tampered);
    await assert.rejects(decryptFile(`${src}.spb`, path.join(env.root, "d.bin"), keys.privateKey), BackupKeyError);
    assert.throws(() => parsePrivateKey("spb-pub-xyz"), BackupKeyError);
  });
});

describe("retensi", () => {
  const key = (/** @type {number} */ t) => objectKey("words", new Date(t));

  it("nama objek ↔ waktu; minggu ISO", () => {
    const t = Date.UTC(2026, 10, 25, 20, 0, 3);
    assert.equal(key(t), "apps/words/2026-11-25T20-00-03Z.tar.gz.spb");
    assert.equal(backupTime(key(t)), t);
    assert.equal(backupTime("apps/words/catatan.txt"), null);
    assert.equal(_isoWeek(Date.UTC(2027, 0, 3)), "2026-W53");
    assert.equal(_isoWeek(Date.UTC(2024, 11, 30)), "2025-W01");
  });

  it("400 hari backup harian → 14 hari terakhir + 8 minggu + 6 bulan; objek lain tidak disentuh", () => {
    const end = Date.UTC(2026, 10, 25, 20, 0, 0);
    const keys = Array.from({ length: 400 }, (_, i) => key(end - i * DAY));
    keys.push("apps/words/README.txt");
    const { keep, remove } = planRetention(keys, end + 3_600_000);
    assert.deepEqual(keep.slice(0, 14), keys.slice(0, 14));
    const weeks = new Set(keep.map((k) => _isoWeek(/** @type {number} */ (backupTime(k)))));
    const months = new Set(keep.map((k) => new Date(/** @type {number} */ (backupTime(k))).toISOString().slice(0, 7)));
    assert.ok(weeks.size >= 8);
    assert.ok(months.size >= 6);
    assert.ok(keep.length <= 14 + 8 + 6);
    assert.equal(keep.length + remove.length, 400);
    assert.ok(!remove.includes("apps/words/README.txt"));
    // Bulan tertua yang disimpan = backup terbaru di bulan itu.
    assert.ok(keep.includes(key(Date.UTC(2026, 5, 30, 20, 0, 0))));
  });

  it("seperti restic --keep-daily: yang dihitung hari yang punya backup, bukan hari kalender", () => {
    // Backup sempat berhenti setahun: backup lama tetap disimpan (tidak ada yang dihapus).
    const now = Date.UTC(2026, 10, 25, 21, 0, 0);
    const keys = [key(now - 3_600_000), key(Date.UTC(2025, 9, 1, 20)), key(Date.UTC(2025, 8, 1, 20))];
    assert.deepEqual(planRetention(keys, now).remove, []);
  });

  it("backup yang lebih muda dari 2 hari tidak pernah dihapus", () => {
    const now = Date.UTC(2026, 10, 25, 22, 0, 0);
    const keys = [0, 1, 2, 3, 4].map((i) => key(now - i * 3_600_000));
    assert.deepEqual(planRetention(keys, now, { daily: 1, weekly: 0, monthly: 0 }).remove, []);
  });
});

describe("deploy.json: field backup", () => {
  it("harus di dalam folder shared, relatif, tanpa ..", () => {
    assert.deepEqual(parseManifest(nodeManifest("words", { backup: ["data/app.db"] })).backup, ["data/app.db"]);
    assert.deepEqual(parseManifest(nodeManifest("words")).backup, []);
    for (const backup of [["dist/app.db"], ["/etc/passwd"], ["data/../../x"], ["data/a", "data/a"], ["data/x/"], "data/app.db"]) {
      assert.throws(() => parseManifest(nodeManifest("words", { backup })), JSON.stringify(backup));
    }
  });

  it("endpoint R2: account ID saja atau URL tanpa path", () => {
    assert.equal(normalizeEndpoint("0123456789ABCDEF0123456789abcdef"), "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    assert.equal(normalizeEndpoint("https://abc.r2.cloudflarestorage.com/"), "https://abc.r2.cloudflarestorage.com");
    assert.throws(() => normalizeEndpoint("http://abc.r2.cloudflarestorage.com"), BackupError);
    assert.throws(() => normalizeEndpoint("https://abc.r2.cloudflarestorage.com/bucket"), BackupError);
  });
});

describe("backup → verify → restore (R2 palsu, SQLite sungguhan)", () => {
  it("snapshot konsisten walau database sedang dibuka; isi terenkripsi; state tercatat", async () => {
    const { db } = await setupApp();
    const keys = configure();
    const s3 = fakeS3();
    const fake = fakeSystem();
    const results = await runBackup({ paths: env.paths, sys: fake.sys, s3: () => s3 });
    const result = /** @type {import("../lib/backup.js").AppBackupResult} */ (results.words);
    assert.equal(result.ok, true, result.error ?? "");
    assert.match(/** @type {string} */ (result.key), /^apps\/words\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz\.spb$/);
    const stored = /** @type {Buffer} */ (s3.objects.get(/** @type {string} */ (result.key)));
    assert.equal(stored.subarray(0, 4).toString(), "SPB1");
    assert.equal(stored.includes(Buffer.from("rahasia-app")), false);
    assert.equal(stored.includes(Buffer.from("SQLite format 3")), false);

    const state = readBackupState(env.paths);
    assert.equal(state.apps.words?.ok, true);
    assert.equal(state.apps.words?.lastSuccessAt, result.at);
    assert.equal(fs.statSync(env.paths.backupState).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(env.paths.backupTmp), [], "folder kerja dibersihkan");

    const verified = await verifyBackup({ paths: env.paths, sys: fake.sys }, s3, "words", "latest", keys.privateKey);
    assert.deepEqual(verified.problems, []);
    assert.deepEqual(
      verified.manifest.files.map((/** @type {{ path: string, sqlite: boolean }} */ f) => [f.path, f.sqlite]),
      [["data/app.db", true], ["data/uploads/", false]],
    );
    assert.equal(verified.manifest.env, true);
    assert.equal(verified.manifest.release.sha, "abcdef1234");
    db.close();
  });

  it("restore mengembalikan data; file lama disimpan; .env hanya kalau diminta; app dihentikan", async () => {
    const { app, db } = await setupApp();
    const keys = configure();
    const s3 = fakeS3();
    await runBackup({ paths: env.paths, sys: fakeSystem().sys, s3: () => s3 });
    db.exec("DELETE FROM kata; INSERT INTO kata VALUES ('rusak');");
    db.close();
    fs.writeFileSync(app.env, "TOKEN=baru\n");

    const fake = fakeSystem();
    const result = await restoreBackup({ paths: env.paths, sys: fake.sys }, s3, "words", "latest", keys.privateKey, { withEnv: false });
    assert.deepEqual(result.restored, ["data/app.db", "data/uploads"]);
    assert.ok(fake.calls.includes("systemctl stop app@words.service"));
    const restored = new DatabaseSync(path.join(app.shared, "data", "app.db"), { readOnly: true });
    assert.deepEqual(restored.prepare("SELECT teks FROM kata ORDER BY teks").all().map((r) => r.teks), ["dunia", "halo"]);
    restored.close();
    const aside = fs.readdirSync(path.join(app.shared, "data")).filter((f) => f.includes(".sebelum-restore-"));
    assert.ok(aside.some((f) => f.startsWith("app.db.sebelum-restore-")), aside.join(","));
    assert.equal(fs.readFileSync(app.env, "utf8"), "TOKEN=baru\n");

    await restoreBackup({ paths: env.paths, sys: fake.sys }, s3, "words", "latest", keys.privateKey, { withEnv: true });
    assert.equal(fs.readFileSync(app.env, "utf8"), "TOKEN=rahasia-app\n");
    assert.equal(fs.statSync(app.env).mode & 0o777, 0o600);
  });

  it("kunci privat yang bukan pasangan config ditolak sebelum mengunduh", async () => {
    await setupApp();
    configure();
    const s3 = fakeS3();
    await runBackup({ paths: env.paths, sys: fakeSystem().sys, s3: () => s3 });
    await assert.rejects(
      verifyBackup({ paths: env.paths, sys: fakeSystem().sys }, s3, "words", "latest", generateBackupKeys().privateKey),
      /bukan pasangan/,
    );
  });

  it("retensi saat unggah; gagal menghapus (bucket lock) hanya jadi catatan", async () => {
    const { db } = await setupApp();
    configure();
    const s3 = fakeS3({ failDelete: true });
    // 40 backup harian tahun lalu: lebih dari jatah 14 + 8 + 6, jadi yang tertua harus dihapus.
    for (let day = 0; day < 40; day += 1) {
      s3.objects.set(objectKey("words", new Date(Date.UTC(2025, 0, 1 + day))), Buffer.from("x"));
    }
    const results = await runBackup({ paths: env.paths, sys: fakeSystem().sys, s3: () => s3 });
    assert.ok(s3.calls.some((c) => c === `delete ${objectKey("words", new Date(Date.UTC(2025, 0, 1)))}`));
    assert.equal(results.words?.ok, true);
    assert.match(results.words?.warnings.join("\n") ?? "", /tidak bisa menghapus backup lama/);
    db.close();
  });

  it("snapshot gagal → hasil gagal tercatat, waktu berhasil terakhir dipertahankan; file hilang = catatan", async () => {
    const { app, db } = await setupApp();
    configure();
    const s3 = fakeS3();
    await runBackup({ paths: env.paths, sys: fakeSystem().sys, s3: () => s3 });
    const firstSuccess = readBackupState(env.paths).apps.words?.lastSuccessAt;
    const failed = await runBackup({
      paths: env.paths,
      sys: fakeSystem().sys,
      s3: () => s3,
      snapshot: () => ({ ok: false, error: "database disk image is malformed" }),
    });
    assert.equal(failed.words?.ok, false);
    assert.match(failed.words?.error ?? "", /snapshot SQLite gagal/);
    assert.equal(readBackupState(env.paths).apps.words?.lastSuccessAt, firstSuccess);

    db.close();
    fs.rmSync(path.join(app.shared, "data", "uploads"), { recursive: true });
    const partial = await runBackup({ paths: env.paths, sys: fakeSystem().sys, s3: () => s3 });
    assert.equal(partial.words?.ok, true);
    assert.deepEqual(partial.words?.warnings, ["data/uploads: tidak ada"]);
  });

  it("agent: status backup per app tanpa kredensial; null kalau backup belum diatur", async () => {
    const { db } = await setupApp();
    const before = await handleRequest({ op: "list" }, { paths: env.paths, sys: fakeSystem().sys });
    assert.equal(/** @type {any[]} */ (before.data)[0].backup, null);
    configure();
    await runBackup({ paths: env.paths, sys: fakeSystem().sys, s3: () => fakeS3() });
    const after = await handleRequest({ op: "list" }, { paths: env.paths, sys: fakeSystem().sys });
    const backup = /** @type {any[]} */ (after.data)[0].backup;
    assert.equal(backup.enabled, true);
    assert.equal(backup.ok, true);
    assert.ok(backup.bytes > 0);
    assert.doesNotMatch(JSON.stringify(after), new RegExp(SECRET));
    db.close();
  });
});

describe("CLI backup", () => {
  /**
   * @param {string[]} answers
   * @param {ReturnType<typeof fakeS3>} s3
   */
  function cliCtx(answers, s3, fake = fakeSystem()) {
    const queue = [...answers];
    return {
      fake,
      ctx: {
        paths: env.paths,
        sys: fake.sys,
        ask: async () => queue.shift() ?? "",
        readSecret: async () => SECRET,
        s3: () => s3,
      },
    };
  }

  it("backup-setup: tes koneksi, kunci privat tampil sekali, secret R2 tidak pernah tampil, config 600", async () => {
    const s3 = fakeS3();
    const { ctx, fake } = cliCtx(["0123456789abcdef0123456789abcdef", "stackfolio-backup", "AKIA0123456789ABCDEF", "sudah"], s3);
    assert.equal(await main(["backup-setup"], ctx), 0, fake.logs.join("\n"));
    const config = JSON.parse(fs.readFileSync(env.paths.backupConfig, "utf8"));
    assert.equal(config.bucket, "stackfolio-backup");
    assert.match(config.publicKey, /^spb-pub-/);
    assert.equal(fs.statSync(env.paths.backupConfig).mode & 0o777, 0o600);
    const logs = fake.logs.join("\n");
    assert.doesNotMatch(logs, new RegExp(SECRET));
    assert.equal(logs.match(/spb-priv-/g)?.length, 1);
    const privateKey = /** @type {string} */ (/spb-priv-[A-Za-z0-9_-]{43}/.exec(logs)?.[0]);
    assert.equal(parsePrivateKey(privateKey).publicKey, config.publicKey);
    assert.deepEqual(
      s3.calls.map((c) => c.split(" ")[0]),
      ["put", "get", "delete"],
    );

    // Setup ulang dengan --keep-key: kunci publik sama, kunci privat tidak ditampilkan.
    const again = cliCtx(["0123456789abcdef0123456789abcdef", "stackfolio-backup", "AKIA0123456789ABCDEF"], fakeS3());
    assert.equal(await main(["backup-setup", "--keep-key"], again.ctx), 0);
    assert.equal(JSON.parse(fs.readFileSync(env.paths.backupConfig, "utf8")).publicKey, config.publicKey);
    assert.doesNotMatch(again.fake.logs.join("\n"), /spb-priv-/);
  });

  it("backup-setup: tanpa SUDAH → config tidak disimpan", async () => {
    const { ctx } = cliCtx(["0123456789abcdef0123456789abcdef", "stackfolio-backup", "AKIA0123456789ABCDEF", "nanti"], fakeS3());
    assert.equal(await main(["backup-setup"], ctx), 1);
    assert.equal(fs.existsSync(env.paths.backupConfig), false);
  });

  it("backup-status: app tanpa apa pun untuk di-backup tidak tampil sebagai 'belum pernah'", async () => {
    const { db } = await setupApp();
    db.close();
    configure();
    await main(["register", "situs"], { paths: env.paths, sys: fakeSystem().sys });
    const archive = makeArchive(env.root, { name: "situs", type: "static", domains: ["situs.stackfolio.web.id"], package: ["dist"], root: "dist" }, { "dist/index.html": "hai" });
    await deploy({ paths: env.paths, sys: fakeSystem().sys, name: "situs", sha: "abcdef1234", archive, stableMs: 0 });
    const { ctx, fake } = cliCtx([], fakeS3());
    assert.equal(await main(["backup-status"], ctx), 0);
    const logs = fake.logs.join("\n");
    assert.match(logs, /situs\s+- tidak ada yang di-backup \(situs statis\)/);
    assert.match(logs, /words\s+belum pernah/);
  });

  it("backup-run tanpa config = dilewati (timer tidak gagal); backup-now tanpa config = error", async () => {
    const { ctx, fake } = cliCtx([], fakeS3());
    assert.equal(await main(["backup-run"], ctx), 0);
    assert.match(fake.logs.join("\n"), /dilewati/);
    assert.equal(await main(["backup-now"], ctx), 1);
  });

  it("backup-now + backup-verify + backup-restore lewat CLI (kunci dari --key-file)", async () => {
    const { db } = await setupApp();
    const keys = configure();
    db.close();
    const s3 = fakeS3();
    const keyFile = path.join(env.root, "kunci.txt");
    fs.writeFileSync(keyFile, `${keys.privateKey}\n`);
    const now = cliCtx([], s3);
    assert.equal(await main(["backup-now"], now.ctx), 0, now.fake.logs.join("\n"));
    assert.match(now.fake.logs.join("\n"), /✓ words/);
    const verify = cliCtx([], s3);
    assert.equal(await main(["backup-verify", "words", "--key-file", keyFile], verify.ctx), 0, verify.fake.logs.join("\n"));
    assert.match(verify.fake.logs.join("\n"), /lolos integrity_check/);
    const cancel = cliCtx(["bukan"], s3);
    assert.equal(await main(["backup-restore", "words", "--key-file", keyFile], cancel.ctx), 1);
    const restore = cliCtx(["words"], s3);
    assert.equal(await main(["backup-restore", "words", "latest", "--key-file", keyFile], restore.ctx), 0, restore.fake.logs.join("\n"));
    assert.ok(restore.fake.calls.includes("systemctl restart app@words.service"));
  });
});

describe("klien S3 (SigV4, fetch palsu)", () => {
  const config = {
    endpoint: "https://akun.r2.cloudflarestorage.com",
    bucket: "backup",
    accessKeyId: "AKIA0123456789ABCDEF",
    secretAccessKey: SECRET,
  };

  it("tanda tangan: scope, header bertanda tangan, deterministik", () => {
    const req = {
      method: "GET",
      host: "akun.r2.cloudflarestorage.com",
      path: "/backup/apps/a%20b",
      query: { prefix: "apps/", "list-type": "2" },
      headers: {},
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: config.accessKeyId,
      secretAccessKey: SECRET,
      region: "auto",
      date: new Date("2026-11-25T20:00:00Z"),
    };
    const a = signV4(req);
    assert.equal(a["x-amz-date"], "20261125T200000Z");
    assert.match(a.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKIA0123456789ABCDEF\/20261125\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(signV4(req).authorization, a.authorization);
    assert.notEqual(signV4({ ...req, path: "/backup/apps/lain" }).authorization, a.authorization);
  });

  it("cocok dengan botocore (AWS CLI v2): vector diambil dari request asli CLI", () => {
    // aws s3api get-object --bucket backup --key "apps/a b+c/2026-11-25T20-00-03Z.tar.gz.spb"
    //   --endpoint-url http://127.0.0.1:35465 --region auto  (kredensial contoh dari dokumentasi AWS)
    const signed = signV4({
      method: "GET",
      host: "127.0.0.1:35465",
      path: "/backup/apps/a%20b%2Bc/2026-11-25T20-00-03Z.tar.gz.spb",
      query: {},
      headers: { "x-amz-checksum-mode": "ENABLED" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIDEXAMPLE0123456789",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "auto",
      date: new Date("2026-11-25T04:51:33Z"),
    });
    assert.match(signed.authorization ?? "", /SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date,/);
    assert.match(signed.authorization ?? "", /Signature=d7f056697f0bc98e9b61ef242e3f308a9f706dedfb0c8cc933fc7885d684c794$/);
  });

  it("daftar objek mengikuti halaman; entitas XML; error tanpa secret", async () => {
    /** @type {string[]} */
    const urls = [];
    const pages = [
      "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok/1</NextContinuationToken><Contents><Key>apps/a&amp;b.spb</Key><Size>10</Size><LastModified>x</LastModified></Contents></ListBucketResult>",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>apps/c.spb</Key><Size>20</Size><LastModified>y</LastModified></Contents></ListBucketResult>",
    ];
    const s3 = createS3(config, {
      fetch: async (url, init) => {
        urls.push(String(url));
        assert.match(String(/** @type {Record<string, string>} */ (init?.headers).authorization), /^AWS4-HMAC-SHA256 /);
        return new Response(pages.shift() ?? "", { status: 200 });
      },
    });
    assert.deepEqual(
      (await s3.listObjects("apps/")).map((o) => [o.key, o.size]),
      [["apps/a&b.spb", 10], ["apps/c.spb", 20]],
    );
    assert.match(urls[1] ?? "", /continuation-token=tok%2F1/);

    const denied = createS3(config, {
      fetch: async () => new Response(`<Error><Code>AccessDenied</Code><Message>key ${SECRET} salah</Message></Error>`, { status: 403 }),
    });
    const error = await denied.putObject("apps/x", Buffer.from("x")).catch((e) => e);
    assert.ok(error instanceof S3Error);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, new RegExp(SECRET));
  });
});
