// @ts-check
// Perintah admin `app` (dijalankan dengan sudo di server).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  BackupError,
  backupPlan,
  listBackups,
  normalizeEndpoint,
  readBackupConfig,
  readBackupState,
  restoreBackup,
  runBackup,
  verifyBackup,
  writeBackupConfig,
} from "./backup.js";
import { BackupKeyError, generateBackupKeys, parsePublic } from "./backup-crypto.js";
import { DeployError, restartApp, rollback } from "./deploy.js";
import { checkEnvFile, envValueProblem, missingEnv, setEnvValue, unsetEnvValue } from "./envfile.js";
import { authorizedKeyLine, hostKeyValue, withoutAppKey } from "./keys.js";
import { NAME_RE } from "./manifest.js";
import { appPaths, isRegistered, listAppNames, readActiveManifest, readState } from "./registry.js";
import { DEFAULT_RETENTION } from "./retention.js";
import { createS3, S3Error } from "./s3.js";
import { must } from "./system.js";

/** @typedef {import("./system.js").System} System */
/** @typedef {import("./system.js").PlatformPaths} PlatformPaths */

export const USAGE = `Pemakaian: sudo app <perintah> [nama] [opsi]

  register <nama> [--rotate-key]  daftarkan app baru (user, folder, .env, key deploy GitHub)
  env <nama> [--keys]             ubah .env app di editor (--keys: tampilkan nama variabel saja)
  list [--json]                   semua app: status, domain, port, versi
  status <nama>                   detail satu app + health check
  logs <nama> [-f] [-n 100]       log aplikasi (journald)
  exec <nama> <perintah...>       jalankan perintah sebagai user app, dengan .env dan folder release-nya
                                  (mis. sudo app exec grammar node dist/cli/user-create.js --email ...)
  restart <nama>                  restart + health check (mis. setelah env diubah)
  env-set <nama> <NAMA_VAR>       isi/ganti satu variabel .env (nilai dibaca dari stdin, tidak tampil)
  env-unset <nama> <NAMA_VAR>     hapus satu variabel .env
  agent-access <nama>             izinkan app ini memakai agent (untuk panel monitoring)
  rollback <nama>                 kembali ke release sebelumnya
  remove <nama> [--purge]         hapus app (--purge: termasuk data dan user sistem)

Backup off-site (Cloudflare R2, terenkripsi; otomatis tiap hari 03:00 WIB):
  backup-setup [--keep-key | --public-key <spb-pub-...>]
                                  atur R2 + buat kunci enkripsi (kunci privat ditampilkan sekali)
  backup-now [nama]               backup sekarang (semua app, atau satu)
  backup-status                   hasil backup terakhir per app + jadwal berikutnya
  backup-list <nama>              daftar backup app di R2
  backup-verify <nama> [latest|file] [--key-file <path>]
                                  buka backup dan cek isinya (butuh kunci privat; tidak mengubah apa pun)
  backup-restore <nama> [latest|file] [--with-env] [--key-file <path>]
                                  pulihkan data app (file lama disimpan *.sebelum-restore-*)
`;

const ENV_TEMPLATE = `# .env app ini. Dibaca systemd saat start (EnvironmentFile); hanya root yang bisa membaca.
# Format: NAMA=nilai, satu per baris, tanpa spasi di sekitar "=". Baris diawali # diabaikan.
# Setelah diubah: sudo app restart <nama>
`;

/**
 * @typedef {object} CliContext
 * @property {PlatformPaths} paths
 * @property {System} sys
 * @property {(file: string) => void} [edit] buka editor (diganti di test)
 * @property {() => Promise<string>} [ask] baca satu baris dari terminal (diganti di test)
 * @property {(prompt?: string) => Promise<string>} [readSecret] baca nilai rahasia tanpa ditampilkan (diganti di test)
 * @property {(config: import("./backup.js").BackupConfig) => import("./s3.js").S3Client} [s3] klien R2 (diganti di test)
 * @property {import("./backup.js").BackupContext["snapshot"]} [snapshot] snapshot SQLite (diganti di test)
 */

/** @param {string} message */
function fail(message) {
  throw new DeployError(message);
}

/**
 * @param {CliContext} ctx
 * @param {string | undefined} name
 */
function requireApp(ctx, name) {
  if (name === undefined) fail("nama app wajib diisi");
  const appName = /** @type {string} */ (name);
  if (!isRegistered(ctx.paths, appName)) fail(`app "${appName}" belum terdaftar`);
  return appName;
}

/**
 * @param {CliContext} ctx
 * @param {string} file
 * @param {string} content
 * @param {number} mode
 */
function writeSecure(ctx, file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/**
 * @param {CliContext} ctx
 * @param {string | undefined} name
 * @param {{ rotateKey: boolean }} opts
 */
function register(ctx, name, opts) {
  const { paths, sys } = ctx;
  if (name === undefined || !NAME_RE.test(name)) {
    fail("nama app: huruf kecil/angka/'-', diawali huruf, 2–31 karakter");
  }
  const appName = /** @type {string} */ (name);
  const app = appPaths(paths, appName);
  const exists = fs.existsSync(app.registration);
  if (exists && !opts.rotateKey) {
    fail(`app "${appName}" sudah terdaftar. Buat key deploy baru: sudo app register ${appName} --rotate-key`);
  }

  if (!exists) {
    if (sys.run("id", ["-u", app.user]).status !== 0) {
      must(sys.run, "useradd", [
        "--system",
        "--user-group",
        "--no-create-home",
        "--home-dir",
        "/nonexistent",
        "--shell",
        "/usr/sbin/nologin",
        app.user,
      ]);
    }
    fs.mkdirSync(app.releases, { recursive: true });
    fs.mkdirSync(app.shared, { recursive: true });
    fs.chmodSync(app.dir, 0o755);
    must(sys.run, "chown", [`root:${app.user}`, app.shared]);
    fs.chmodSync(app.shared, 0o750);
    if (!fs.existsSync(app.env)) writeSecure(ctx, app.env, ENV_TEMPLATE.replace("<nama>", appName), 0o600);
    fs.writeFileSync(
      app.registration,
      `${JSON.stringify({ name: appName, created_at: sys.now().toISOString() }, null, 2)}\n`,
    );
  }

  // Key deploy khusus app ini. Private key hanya dicetak sekali, lalu dihapus dari server.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-key-"));
  let privateKey;
  let publicKey;
  try {
    const keyFile = path.join(tmp, "key");
    must(sys.run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `deploy-${appName}`, "-f", keyFile]);
    privateKey = fs.readFileSync(keyFile, "utf8");
    publicKey = fs.readFileSync(`${keyFile}.pub`, "utf8");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const current = fs.existsSync(paths.deployAuthorizedKeys) ? fs.readFileSync(paths.deployAuthorizedKeys, "utf8") : "";
  const line = authorizedKeyLine(appName, publicKey, paths.deploySsh);
  writeSecure(ctx, paths.deployAuthorizedKeys, `${withoutAppKey(current, appName)}${line}\n`, 0o600);
  must(sys.run, "chown", ["deploy:deploy", paths.deployAuthorizedKeys]);

  const hostKey = hostKeyValue(fs.readFileSync(paths.hostKey, "utf8"));
  const addresses = sys.run("hostname", ["-I"]).stdout.trim().split(/\s+/).filter(Boolean);
  sys.log(
    [
      exists ? `Key deploy baru untuk "${appName}" (key lama tidak berlaku lagi).` : `App "${appName}" terdaftar.`,
      "",
      "Isi 3 secret ini di GitHub: repo → Settings → Secrets and variables → Actions → New repository secret.",
      "Private key hanya tampil SEKALI dan tidak disimpan di server.",
      "",
      "DEPLOY_HOST     = IP publik VM ini (salah satu dari: " + (addresses.join(", ") || "?") + ")",
      `DEPLOY_HOST_KEY = ${hostKey}`,
      "DEPLOY_SSH_KEY  = (salin semua baris di bawah, termasuk BEGIN/END)",
      privateKey.trimEnd(),
      "",
      exists ? "" : `Berikutnya: sudo app env ${appName}   (isi .env), lalu push repo-nya.`,
    ].join("\n"),
  );
}

/**
 * @param {CliContext} ctx
 * @param {string | undefined} name
 * @param {{ keysOnly: boolean }} opts
 */
function env(ctx, name, opts) {
  const { paths, sys } = ctx;
  const appName = requireApp(ctx, name);
  const app = appPaths(paths, appName);
  const text = fs.existsSync(app.env) ? fs.readFileSync(app.env, "utf8") : "";
  const manifest = readActiveManifest(paths, appName);
  const required = manifest?.type === "node" ? manifest.required_env : [];

  if (opts.keysOnly) {
    const { keys } = checkEnvFile(text);
    sys.log(keys.length === 0 ? "(kosong)" : keys.join("\n"));
    const missing = missingEnv(text, required);
    if (missing.length > 0) sys.log(`\nWajib tapi belum diisi: ${missing.join(", ")}`);
    return;
  }

  const draft = path.join(app.shared, `.env.edit-${process.pid}`);
  writeSecure(ctx, draft, text, 0o600);
  try {
    (ctx.edit ?? openEditor)(draft);
    const edited = fs.readFileSync(draft, "utf8");
    const { keys, problems } = checkEnvFile(edited);
    if (problems.length > 0) fail(`.env TIDAK disimpan:\n  - ${problems.join("\n  - ")}`);
    writeSecure(ctx, app.env, edited.endsWith("\n") || edited === "" ? edited : `${edited}\n`, 0o600);
    sys.log(`.env disimpan (${keys.length} variabel): ${keys.join(", ") || "-"}`);
    const missing = missingEnv(edited, required);
    if (missing.length > 0) sys.log(`Wajib tapi belum diisi: ${missing.join(", ")}`);
    if (manifest !== null) sys.log(`Terapkan: sudo app restart ${appName}`);
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

/** @param {string} file */
function openEditor(file) {
  const editor = (process.env.VISUAL || process.env.EDITOR || "nano").split(/\s+/);
  const [cmd, ...args] = editor;
  const result = spawnSync(/** @type {string} */ (cmd), [...args, file], { stdio: "inherit" });
  if (result.status !== 0) fail("editor ditutup dengan error; .env tidak diubah");
}

/**
 * @param {CliContext} ctx
 * @param {string} name
 */
function appInfo(ctx, name) {
  const { paths, sys } = ctx;
  const app = appPaths(paths, name);
  const manifest = readActiveManifest(paths, name);
  const state = readState(app, name);
  let status = "belum deploy";
  if (manifest?.type === "static") status = "static";
  else if (manifest?.type === "node") status = sys.run("systemctl", ["is-active", app.unit]).stdout.trim() || "unknown";
  return {
    name,
    type: manifest?.type ?? null,
    status,
    domains: manifest?.domains ?? [],
    port: manifest?.type === "node" ? manifest.port : null,
    health: manifest?.type === "node" ? manifest.health : null,
    sha: state.current?.sha ?? null,
    deployed_at: state.current?.at ?? null,
    previous_sha: state.previous?.sha ?? null,
    last_result: state.history.at(-1)?.result ?? null,
  };
}

/**
 * @param {CliContext} ctx
 * @param {{ json: boolean }} opts
 */
function list(ctx, opts) {
  const apps = listAppNames(ctx.paths).map((name) => appInfo(ctx, name));
  if (opts.json) {
    ctx.sys.log(JSON.stringify(apps, null, 2));
    return;
  }
  if (apps.length === 0) {
    ctx.sys.log("Belum ada app. Daftarkan: sudo app register <nama>");
    return;
  }
  const rows = [
    ["APP", "TIPE", "STATUS", "PORT", "VERSI", "DEPLOY (UTC)", "DOMAIN"],
    ...apps.map((a) => [
      a.name,
      a.type ?? "-",
      a.status,
      a.port === null ? "-" : String(a.port),
      a.sha?.slice(0, 7) ?? "-",
      a.deployed_at?.slice(0, 16).replace("T", " ") ?? "-",
      a.domains.join(", ") || "-",
    ]),
  ];
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  for (const row of rows) ctx.sys.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
}

/**
 * @param {CliContext} ctx
 * @param {string | undefined} name
 */
async function status(ctx, name) {
  const appName = requireApp(ctx, name);
  const info = appInfo(ctx, appName);
  const app = appPaths(ctx.paths, appName);
  ctx.sys.log(JSON.stringify(info, null, 2));
  if (info.port !== null) {
    const code = await ctx.sys.httpStatus(`http://127.0.0.1:${info.port}${info.health}`, 3_000);
    ctx.sys.log(`health ${info.health}: ${code === 0 ? "tidak menjawab" : `HTTP ${code}`}`);
  }
  const history = readState(app, appName).history.slice(-5);
  if (history.length > 0) {
    ctx.sys.log("\nRiwayat terakhir:");
    for (const h of history) ctx.sys.log(`  ${h.at.slice(0, 19)}  ${h.sha.slice(0, 7)}  ${h.result}${h.error ? `  (${h.error})` : ""}`);
  }
}

/**
 * @param {CliContext} ctx
 * @param {string | undefined} name
 * @param {{ purge: boolean }} opts
 */
async function remove(ctx, name, opts) {
  const { paths, sys } = ctx;
  const appName = requireApp(ctx, name);
  const app = appPaths(paths, appName);
  sys.log(
    opts.purge
      ? `HAPUS app "${appName}" beserta data (${app.shared}) dan user ${app.user}. Tidak bisa dibatalkan.`
      : `Hapus app "${appName}" dari Caddy/systemd dan cabut key deploy-nya. Data di ${app.dir} tetap ada.`,
  );
  sys.log(`Ketik nama app (${appName}) untuk konfirmasi:`);
  const answer = (await (ctx.ask ?? askLine)()).trim();
  if (answer !== appName) fail("konfirmasi tidak cocok; tidak ada yang dihapus");

  sys.run("systemctl", ["disable", "--now", "--quiet", app.unit]);
  fs.rmSync(app.dropInDir, { recursive: true, force: true });
  must(sys.run, "systemctl", ["daemon-reload"]);
  fs.rmSync(app.site, { force: true });
  must(sys.run, "caddy", ["validate", "--config", paths.caddyfile, "--adapter", "caddyfile"]);
  must(sys.run, "systemctl", ["reload", "caddy"]);
  if (fs.existsSync(paths.deployAuthorizedKeys)) {
    writeSecure(ctx, paths.deployAuthorizedKeys, withoutAppKey(fs.readFileSync(paths.deployAuthorizedKeys, "utf8"), appName), 0o600);
  }
  if (opts.purge) {
    fs.rmSync(app.dir, { recursive: true, force: true });
    sys.run("userdel", [app.user]);
  } else {
    fs.rmSync(app.registration, { force: true });
  }
  sys.log(`App "${appName}" dihapus.`);
}

/**
 * Argumen systemd-run untuk menjalankan perintah seperti service app: user app-<nama>, env dari
 * shared/.env (dibaca systemd, bukan oleh user), folder kerja = release aktif.
 * @param {PlatformPaths} paths
 * @param {string} name
 * @param {string[]} command
 * @param {boolean} tty
 */
export function execArgs(paths, name, command, tty) {
  const app = appPaths(paths, name);
  const [cmd, ...args] = command;
  return [
    "--quiet",
    "--wait",
    "--collect",
    tty ? "--pty" : "--pipe",
    `--uid=${app.user}`,
    `--gid=${app.user}`,
    "--property",
    `EnvironmentFile=${app.env}`,
    "--property",
    `WorkingDirectory=${app.current}`,
    "--setenv=NODE_ENV=production",
    "--",
    cmd === "node" ? paths.nodeBin : /** @type {string} */ (cmd),
    ...args,
  ];
}

/**
 * @param {CliContext} ctx
 * @param {string | undefined} name
 * @param {string | undefined} key
 * @param {"set" | "unset"} mode
 */
async function envChange(ctx, name, key, mode) {
  const appName = requireApp(ctx, name);
  const file = appPaths(ctx.paths, appName).env;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (mode === "set") {
    const value = await (ctx.readSecret ?? readSecretLine)();
    const problem = envValueProblem(key ?? "", value);
    if (problem !== null) fail(problem);
    writeSecure(ctx, file, setEnvValue(text, /** @type {string} */ (key), value), 0o600);
    ctx.sys.log(`${key} disimpan. Terapkan: sudo app restart ${appName}`);
  } else {
    writeSecure(ctx, file, unsetEnvValue(text, key ?? ""), 0o600);
    ctx.sys.log(`${key} dihapus. Terapkan: sudo app restart ${appName}`);
  }
}

// ---- Backup -------------------------------------------------------------------------------

/** @param {CliContext} ctx */
function backupS3(ctx) {
  const config = readBackupConfig(ctx.paths);
  if (config === null) fail("backup belum diatur: sudo app backup-setup");
  return (ctx.s3 ?? createS3)(/** @type {import("./backup.js").BackupConfig} */ (config));
}

/** @param {number | null | undefined} bytes */
const size = (bytes) => (bytes === null || bytes === undefined ? "-" : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * @param {CliContext} ctx
 * @param {{ keepKey: boolean, publicKey: string | null }} opts
 */
async function backupSetup(ctx, opts) {
  const { paths, sys } = ctx;
  const ask = ctx.ask ?? askLine;
  const secret = ctx.readSecret ?? readSecretLine;
  /** @type {import("./backup.js").BackupConfig | null} */
  let existing = null;
  try {
    existing = readBackupConfig(paths);
  } catch {
    existing = null;
  }
  if (opts.keepKey && existing === null) fail("--keep-key: belum ada config backup sebelumnya");
  if (opts.publicKey) parsePublic(opts.publicKey);

  sys.log("Endpoint R2 (https://<account-id>.r2.cloudflarestorage.com, atau account ID saja):");
  const endpoint = normalizeEndpoint(await ask());
  sys.log("Nama bucket:");
  const bucket = (await ask()).trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) fail("nama bucket: huruf kecil, angka, '-' (3–63 karakter)");
  sys.log("Access Key ID:");
  const accessKeyId = (await ask()).trim();
  if (!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId)) fail("Access Key ID tidak valid");
  const secretAccessKey = (await secret("Secret Access Key (tidak tampil): ")).trim();
  if (!/^[A-Za-z0-9/+=]{16,128}$/.test(secretAccessKey)) fail("Secret Access Key tidak valid");

  sys.log("Mengetes koneksi ke R2…");
  const s3 = (ctx.s3 ?? createS3)({ endpoint, bucket, accessKeyId, secretAccessKey, region: "auto", publicKey: "", includeEnv: true, retention: DEFAULT_RETENTION });
  const testKey = `_setup-test/${sys.now().toISOString().replace(/[:.]/g, "-")}.txt`;
  const content = Buffer.from("server-platform backup-setup\n");
  await s3.putObject(testKey, content, "text/plain");
  if (!(await s3.listObjects("_setup-test/")).some((o) => o.key === testKey)) fail("objek tes tidak muncul di daftar bucket");
  if (!(await s3.getObject(testKey)).equals(content)) fail("isi objek tes berbeda saat diunduh");
  try {
    await s3.deleteObject(testKey);
  } catch (error) {
    sys.log(`! objek tes tidak bisa dihapus (bucket lock?): ${error instanceof Error ? error.message : String(error)}`);
  }
  sys.log("✓ R2 bisa diunggah, didaftar, dan diunduh");

  /** @type {string} */
  let publicKey;
  if (opts.publicKey) {
    publicKey = opts.publicKey.trim();
  } else if (opts.keepKey && existing) {
    publicKey = existing.publicKey;
    sys.log("Kunci enkripsi lama dipakai lagi.");
  } else {
    const keys = generateBackupKeys();
    sys.log(
      [
        "",
        "================ KUNCI PRIVAT BACKUP (tampil sekali) ================",
        keys.privateKey,
        "=====================================================================",
        "Simpan SEKARANG di password manager. Kunci ini tidak disimpan di server.",
        "Tanpa kunci ini, backup tidak bisa dibuka (restore tidak mungkin).",
        "",
        'Ketik SUDAH setelah kunci tersimpan (selain itu = batal, config tidak disimpan):',
      ].join("\n"),
    );
    if ((await ask()).trim().toUpperCase() !== "SUDAH") fail("dibatalkan: config backup tidak disimpan");
    publicKey = keys.publicKey;
  }

  writeBackupConfig(paths, {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: "auto",
    publicKey,
    includeEnv: existing?.includeEnv ?? true,
    retention: existing?.retention ?? DEFAULT_RETENTION,
  });
  sys.log(`✓ Config disimpan di ${paths.backupConfig} (hanya root).`);
  sys.log("Backup otomatis tiap hari 03:00 WIB. Backup pertama sekarang: sudo app backup-now");
}

/** @param {CliContext} ctx */
function backupStatus(ctx) {
  const { paths, sys } = ctx;
  const config = readBackupConfig(paths);
  if (config === null) {
    sys.log("Backup belum diatur: sudo app backup-setup");
    return;
  }
  sys.log(`R2: ${new URL(config.endpoint).host} / ${config.bucket}`);
  sys.log(`Kunci publik: ${config.publicKey.slice(0, 20)}…  ·  .env ikut: ${config.includeEnv ? "ya" : "tidak"}`);
  sys.log(`Retensi: ${config.retention.daily} harian, ${config.retention.weekly} mingguan, ${config.retention.monthly} bulanan`);
  const next = sys.run("systemctl", ["show", "server-platform-backup.timer", "-p", "NextElapseUSecRealtime", "--value"]).stdout.trim();
  if (next) sys.log(`Jadwal berikutnya: ${next}`);
  const state = readBackupState(paths);
  for (const name of listAppNames(paths)) {
    const last = state.apps[name];
    if (backupPlan(paths, name, config) === null) {
      sys.log(`  ${name.padEnd(16)} - tidak ada yang di-backup${readActiveManifest(paths, name)?.type === "static" ? " (situs statis)" : ' (isi "backup" di deploy.json)'}`);
      continue;
    }
    if (!last) {
      sys.log(`  ${name.padEnd(16)} belum pernah`);
      continue;
    }
    sys.log(
      `  ${name.padEnd(16)} ${last.ok ? "✓" : "✗"} ${last.at}  ${size(last.bytes)}${last.error ? `  ${last.error}` : ""}${!last.ok && last.lastSuccessAt ? `  (terakhir berhasil ${last.lastSuccessAt})` : ""}`,
    );
  }
}

/**
 * Kunci privat dari --key-file atau diketik (tidak tampil).
 * @param {CliContext} ctx
 * @param {string | null} keyFile
 */
async function readPrivateKey(ctx, keyFile) {
  if (keyFile) return fs.readFileSync(keyFile, "utf8").trim();
  return (await (ctx.readSecret ?? readSecretLine)("Kunci privat backup spb-priv-… (tidak tampil): ")).trim();
}

/** Nilai dari stdin. Di terminal: diketik tanpa tampil. */
async function readSecretLine(prompt = "Nilai (tidak tampil): ") {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
      rl.close();
      return line.replace(/\r$/, "");
    }
    return "";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = process.stdout.write.bind(process.stdout);
  let muted = false;
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (/** @type {string | Uint8Array} */ chunk, /** @type {never[]} */ ...rest) => (muted ? true : write(chunk, ...rest))
  );
  try {
    const answer = rl.question(prompt);
    muted = true;
    return await answer;
  } finally {
    process.stdout.write = write;
    process.stdout.write("\n");
    rl.close();
  }
}

async function askLine() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("> ");
  } finally {
    rl.close();
  }
}

/**
 * @param {string[]} argv tanpa "node app"
 * @param {CliContext} ctx
 * @returns {Promise<number>} kode keluar
 */
export async function main(argv, ctx) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const valueFlags = ["-n", "--key-file", "--public-key"];
  const positional = rest.filter((a, i) => !a.startsWith("-") && !valueFlags.includes(rest[i - 1] ?? ""));
  /** @param {string} flag */
  const flagValue = (flag) => (rest.includes(flag) ? (rest[rest.indexOf(flag) + 1] ?? null) : null);
  const name = positional[0];
  const opts = { paths: ctx.paths, sys: ctx.sys };
  try {
    switch (command) {
      case "register":
        register(ctx, name, { rotateKey: flags.has("--rotate-key") });
        return 0;
      case "env":
        env(ctx, name, { keysOnly: flags.has("--keys") });
        return 0;
      case "list":
        list(ctx, { json: flags.has("--json") });
        return 0;
      case "status":
        await status(ctx, name);
        return 0;
      case "logs": {
        const appName = requireApp(ctx, name);
        const lines = rest[rest.indexOf("-n") + 1];
        const count = rest.includes("-n") && lines && /^\d+$/.test(lines) ? lines : "100";
        const result = spawnSync(
          "journalctl",
          ["-u", appPaths(ctx.paths, appName).unit, "--no-pager", "-o", "short-iso", "-n", count, ...(flags.has("-f") ? ["-f"] : [])],
          { stdio: "inherit" },
        );
        return result.status ?? 1;
      }
      case "exec": {
        const appName = requireApp(ctx, name);
        const command = argv.slice(2);
        if (command.length === 0) fail("perintah wajib diisi, mis.: sudo app exec <nama> node dist/cli/x.js");
        if (readActiveManifest(ctx.paths, appName) === null) fail(`app "${appName}" belum pernah di-deploy`);
        const result = spawnSync("systemd-run", execArgs(ctx.paths, appName, command, Boolean(process.stdin.isTTY)), {
          stdio: "inherit",
        });
        return result.status ?? 1;
      }
      case "env-set":
        await envChange(ctx, name, positional[1], "set");
        return 0;
      case "env-unset":
        await envChange(ctx, name, positional[1], "unset");
        return 0;
      case "agent-access": {
        const appName = requireApp(ctx, name);
        must(ctx.sys.run, "usermod", ["-aG", "platform-agent", appPaths(ctx.paths, appName).user]);
        ctx.sys.log(`${appPaths(ctx.paths, appName).user} boleh memakai agent. Terapkan: sudo app restart ${appName}`);
        return 0;
      }
      case "restart":
        await restartApp({ ...opts, name: requireApp(ctx, name) });
        ctx.sys.log(`${name} di-restart dan sehat ✅`);
        return 0;
      case "rollback":
        await rollback({ ...opts, name: requireApp(ctx, name) });
        return 0;
      case "remove":
        await remove(ctx, name, { purge: flags.has("--purge") });
        return 0;
      case "backup-setup":
        await backupSetup(ctx, { keepKey: flags.has("--keep-key"), publicKey: flagValue("--public-key") });
        return 0;
      case "backup-now":
      case "backup-run": {
        if (command === "backup-run" && readBackupConfig(ctx.paths) === null) {
          ctx.sys.log("Backup belum diatur (sudo app backup-setup); dilewati.");
          return 0;
        }
        const results = await runBackup(
          { paths: ctx.paths, sys: ctx.sys, s3: ctx.s3, snapshot: ctx.snapshot },
          { app: name === undefined ? undefined : requireApp(ctx, name) },
        );
        if (Object.keys(results).length === 0) ctx.sys.log('Tidak ada yang di-backup. Isi "backup" di deploy.json app.');
        return Object.values(results).every((r) => r.ok) ? 0 : 1;
      }
      case "backup-status":
        backupStatus(ctx);
        return 0;
      case "backup-list": {
        const appName = requireApp(ctx, name);
        const backups = await listBackups(backupS3(ctx), appName);
        if (backups.length === 0) ctx.sys.log(`Belum ada backup untuk ${appName}.`);
        for (const b of backups) ctx.sys.log(`${new Date(/** @type {number} */ (b.time)).toISOString()}  ${size(b.size).padStart(9)}  ${path.basename(b.key)}`);
        return 0;
      }
      case "backup-verify": {
        const appName = requireApp(ctx, name);
        const s3 = backupS3(ctx);
        const key = await readPrivateKey(ctx, flagValue("--key-file"));
        const result = await verifyBackup({ paths: ctx.paths, sys: ctx.sys, snapshot: ctx.snapshot }, s3, appName, positional[1] ?? "latest", key);
        ctx.sys.log(`${path.basename(result.key)}: dibuat ${result.manifest.createdAt}, versi ${result.manifest.release?.sha?.slice(0, 7) ?? "-"}`);
        for (const file of result.manifest.files) ctx.sys.log(`  ${file.path} ${file.sqlite ? "(SQLite)" : ""} ${size(file.bytes)}`);
        if (result.manifest.env) ctx.sys.log("  .env");
        if (result.problems.length > 0) {
          ctx.sys.log(`✗ Bermasalah:\n  - ${result.problems.join("\n  - ")}`);
          return 1;
        }
        ctx.sys.log("✓ Backup bisa dibuka, checksum cocok, SQLite lolos integrity_check.");
        return 0;
      }
      case "backup-restore": {
        const appName = requireApp(ctx, name);
        const s3 = backupS3(ctx);
        const which = positional[1] ?? "latest";
        ctx.sys.log(
          `Data ${appName} akan diganti dengan backup "${which}"${flags.has("--with-env") ? " (termasuk .env)" : ""}. App dihentikan sebentar. File lama disimpan sebagai *.sebelum-restore-*.`,
        );
        ctx.sys.log(`Ketik nama app (${appName}) untuk lanjut:`);
        if ((await (ctx.ask ?? askLine)()).trim() !== appName) fail("dibatalkan");
        const key = await readPrivateKey(ctx, flagValue("--key-file"));
        const result = await restoreBackup({ paths: ctx.paths, sys: ctx.sys }, s3, appName, which, key, { withEnv: flags.has("--with-env") });
        ctx.sys.log(`✓ Dipulihkan dari ${path.basename(result.key)}: ${result.restored.join(", ")}`);
        if (result.startNeeded) {
          await restartApp({ ...opts, name: appName });
          ctx.sys.log(`${appName} jalan lagi dan sehat ✅`);
        }
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        ctx.sys.log(USAGE);
        return command === undefined ? 1 : 0;
      default:
        ctx.sys.log(`Perintah tidak dikenal: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    const known = error instanceof DeployError || error instanceof BackupError || error instanceof BackupKeyError || error instanceof S3Error;
    ctx.sys.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    if (!known && error instanceof Error && error.stack && process.env.APP_DEBUG) ctx.sys.log(error.stack);
    return 1;
  }
}
