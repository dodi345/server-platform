// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../lib/cli.js";
import { DeployError, deploy, KEEP_RELEASES, releaseName, rollback } from "../lib/deploy.js";
import { appPaths, readState } from "../lib/registry.js";
import { createTestEnv, fakeSystem, makeArchive, NODE_FILES, nodeManifest } from "./helpers.js";

/** @type {ReturnType<typeof createTestEnv>} */
let env;
const SHA1 = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const SHA2 = "b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1";

beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

/**
 * @param {string} name
 * @param {string} [envText]
 */
async function register(name, envText) {
  const { sys } = fakeSystem();
  assert.equal(await main(["register", name], { paths: env.paths, sys }), 0);
  if (envText !== undefined) fs.writeFileSync(appPaths(env.paths, name).env, envText);
}

/**
 * @param {string} name
 * @param {string} sha
 * @param {Record<string, unknown>} manifest
 * @param {ReturnType<typeof fakeSystem>} fake
 * @param {Record<string, string>} [files]
 */
function run(name, sha, manifest, fake, files = NODE_FILES) {
  const archive = makeArchive(env.root, manifest, files);
  return deploy({ paths: env.paths, sys: fake.sys, name, sha, archive, healthTimeoutMs: 5_000, stableMs: 0 });
}

describe("register (sudo app register)", () => {
  it("membuat folder, .env 600, registrasi, dan key deploy yang dikunci ke app", async () => {
    const fake = fakeSystem();
    assert.equal(await main(["register", "words"], { paths: env.paths, sys: fake.sys }), 0);
    const app = appPaths(env.paths, "words");
    assert.ok(fs.existsSync(app.registration));
    assert.equal(fs.statSync(app.env).mode & 0o777, 0o600);
    assert.ok(fake.calls.some((c) => c.startsWith("useradd --system --user-group") && c.endsWith(" app-words")));
    const keys = fs.readFileSync(env.paths.deployAuthorizedKeys, "utf8");
    assert.match(keys, /^restrict,command="\/usr\/local\/bin\/app-deploy-ssh words" ssh-ed25519 \S+ deploy-words\n$/);
    const output = fake.logs.join("\n");
    assert.match(output, /BEGIN OPENSSH PRIVATE KEY/);
    assert.match(output, /DEPLOY_HOST_KEY = ssh-ed25519 \S+/);
    assert.match(output, /203\.0\.113\.10/);
  });

  it("daftar ulang ditolak; --rotate-key mengganti key lama tanpa menyentuh .env", async () => {
    await register("words", "TOKEN=x\n");
    const first = fs.readFileSync(env.paths.deployAuthorizedKeys, "utf8");
    const fake = fakeSystem();
    assert.equal(await main(["register", "words"], { paths: env.paths, sys: fake.sys }), 1);
    assert.equal(await main(["register", "words", "--rotate-key"], { paths: env.paths, sys: fake.sys }), 0);
    const second = fs.readFileSync(env.paths.deployAuthorizedKeys, "utf8");
    assert.notEqual(first, second);
    assert.equal(second.trim().split("\n").length, 1);
    assert.equal(fs.readFileSync(appPaths(env.paths, "words").env, "utf8"), "TOKEN=x\n");
  });
});

describe("deploy app node", () => {
  it("release baru aktif: current, data shared, systemd, Caddy, state", async () => {
    await register("words");
    const fake = fakeSystem();
    await run("words", SHA1, nodeManifest("words", { domains: ["words.stackfolio.web.id"] }), fake);

    const app = appPaths(env.paths, "words");
    const release = fs.readlinkSync(app.current);
    assert.match(release, /^releases\/\d{14}-a1b2c3d4e5f6$/);
    assert.equal(fs.readlinkSync(path.join(app.dir, release, "data")), "../../shared/data");
    assert.ok(fs.statSync(path.join(app.shared, "data")).isDirectory());
    assert.match(fs.readFileSync(app.dropIn, "utf8"), /^ExecStart=\/usr\/bin\/node dist\/server\.js$/m);
    assert.match(fs.readFileSync(app.site, "utf8"), /^words\.stackfolio\.web\.id \{$/m);
    assert.ok(fake.calls.includes("systemctl restart app@words.service"));
    assert.ok(fake.calls.includes("systemctl reload caddy"));
    const state = readState(app, "words");
    assert.equal(state.current?.sha, SHA1);
    assert.equal(state.history.at(-1)?.result, "ok");
  });

  it("health check gagal → kembali ke release sebelumnya, release gagal dihapus", async () => {
    await register("words");
    await run("words", SHA1, nodeManifest("words"), fakeSystem());
    const app = appPaths(env.paths, "words");
    const good = fs.readlinkSync(app.current);
    const goodSite = fs.readFileSync(app.site, "utf8");

    const fake = fakeSystem({ health: () => 502 });
    await assert.rejects(
      run("words", SHA2, nodeManifest("words", { domains: ["baru.stackfolio.web.id"] }), fake),
      /tidak menjawab dalam 5 detik/,
    );
    assert.equal(fs.readlinkSync(app.current), good);
    assert.equal(fs.readFileSync(app.site, "utf8"), goodSite);
    assert.equal(fs.readdirSync(app.releases).length, 1);
    assert.equal(fake.calls.filter((c) => c === "systemctl restart app@words.service").length, 2);
    assert.ok(fake.logs.some((l) => l.includes("baris log aplikasi")));
    const state = readState(app, "words");
    assert.equal(state.current?.sha, SHA1);
    assert.equal(state.history.at(-1)?.result, "failed");
  });

  it("service mati setelah sempat sehat (mis. 409) → gagal", async () => {
    await register("words");
    let checks = 0;
    const fake = fakeSystem({ activeState: () => (checks++ < 1 ? "activating" : "failed") });
    await assert.rejects(run("words", SHA1, nodeManifest("words"), fake), /berhenti/);
  });

  it("proses crash berulang (restart otomatis systemd) → gagal cepat, versi lama dinyalakan ulang", async () => {
    await register("words");
    await run("words", SHA1, nodeManifest("words"), fakeSystem());
    let restartCount = 0;
    const fake = fakeSystem({ health: () => 0, restarts: () => restartCount++ });
    await assert.rejects(run("words", SHA2, nodeManifest("words"), fake), /crash saat start/);
    const resets = fake.calls.filter((c) => c === "systemctl reset-failed app@words.service");
    assert.equal(resets.length, 2); // sebelum versi baru, dan sebelum versi lama dinyalakan ulang
    assert.equal(readState(appPaths(env.paths, "words"), "words").current?.sha, SHA1);
  });

  it("deploy pertama gagal → app tidak aktif sama sekali", async () => {
    await register("words");
    const fake = fakeSystem({ caddyValid: false });
    await assert.rejects(run("words", SHA1, nodeManifest("words"), fake), /caddy validate/);
    const app = appPaths(env.paths, "words");
    assert.equal(fs.existsSync(app.current), false);
    assert.equal(fs.existsSync(app.site), false);
    assert.equal(fs.existsSync(app.dropIn), false);
    assert.ok(fake.calls.includes("systemctl disable --now --quiet app@words.service"));
  });

  it("ditolak sebelum menyentuh app: nama beda, env wajib kosong, versi Node beda, data ikut paket", async () => {
    await register("words", "LLM_API_KEY=\n");
    const cases = /** @type {[Record<string, unknown>, Record<string, string>, RegExp, object?][]} */ ([
      [nodeManifest("lain"), NODE_FILES, /app "words"/],
      [nodeManifest("words", { required_env: ["LLM_API_KEY"] }), NODE_FILES, /env belum diisi: LLM_API_KEY/],
      [nodeManifest("words"), NODE_FILES, /Node 24, server punya v22/, { nodeVersion: "v22.1.0" }],
      [nodeManifest("words"), { ...NODE_FILES, "data/app.db": "x" }, /folder "data" ada di paket/],
      [nodeManifest("words", { start: ["node", "dist/tidak-ada.js"] }), NODE_FILES, /tidak ada di paket/],
    ]);
    for (const [manifest, files, message, options] of cases) {
      const fake = fakeSystem(options);
      await assert.rejects(run("words", SHA1, manifest, fake, files), message);
      assert.ok(!fake.calls.some((c) => c.startsWith("systemctl restart")), String(message));
    }
    const app = appPaths(env.paths, "words");
    assert.equal(fs.existsSync(app.current), false);
    assert.deepEqual(fs.readdirSync(app.releases), []);
  });

  it("bentrok domain/port dengan app lain ditolak", async () => {
    await register("satu");
    await register("dua");
    await run("satu", SHA1, nodeManifest("satu", { domains: ["x.com"], port: 4300 }), fakeSystem());
    await assert.rejects(
      run("dua", SHA1, nodeManifest("dua", { domains: ["x.com"], port: 4300 }), fakeSystem()),
      (error) => error instanceof DeployError && /domain x\.com/.test(error.message) && /port 4300/.test(error.message),
    );
  });

  it("app belum terdaftar dan sha tidak valid ditolak", async () => {
    await assert.rejects(run("hantu", SHA1, nodeManifest("hantu"), fakeSystem()), /belum terdaftar/);
    await register("words");
    await assert.rejects(run("words", "bukan-sha", nodeManifest("words"), fakeSystem()), /sha tidak valid/);
  });

  it(`release lama dibersihkan: ${KEEP_RELEASES} terbaru (+ previous) disimpan`, async () => {
    await register("words");
    for (let i = 0; i < 6; i += 1) {
      await run("words", `${String(i).repeat(7)}abc`, nodeManifest("words"), fakeSystem());
    }
    const app = appPaths(env.paths, "words");
    const releases = fs.readdirSync(app.releases).sort();
    assert.equal(releases.length, KEEP_RELEASES);
    assert.equal(`releases/${releases.at(-1)}`, fs.readlinkSync(app.current));
  });

  it("kunci deploy: deploy lain yang sedang jalan ditolak", async () => {
    await register("words");
    fs.writeFileSync(appPaths(env.paths, "words").lock, String(process.pid));
    await assert.rejects(run("words", SHA1, nodeManifest("words"), fakeSystem()), /sedang berjalan/);
  });
});

describe("rollback", () => {
  it("kembali ke release sebelumnya, lalu bisa maju lagi", async () => {
    await register("words");
    await run("words", SHA1, nodeManifest("words"), fakeSystem());
    await run("words", SHA2, nodeManifest("words"), fakeSystem());
    const app = appPaths(env.paths, "words");

    await rollback({ paths: env.paths, sys: fakeSystem().sys, name: "words", healthTimeoutMs: 5_000, stableMs: 0 });
    assert.equal(readState(app, "words").current?.sha, SHA1);
    assert.match(fs.readlinkSync(app.current), /-a1b2c3d4e5f6$/);

    await rollback({ paths: env.paths, sys: fakeSystem().sys, name: "words", healthTimeoutMs: 5_000, stableMs: 0 });
    assert.equal(readState(app, "words").current?.sha, SHA2);
  });

  it("tanpa release sebelumnya → ditolak", async () => {
    await register("words");
    await run("words", SHA1, nodeManifest("words"), fakeSystem());
    await assert.rejects(
      rollback({ paths: env.paths, sys: fakeSystem().sys, name: "words" }),
      /tidak ada release sebelumnya/,
    );
  });
});

describe("deploy situs statis", () => {
  it("tanpa service systemd; Caddy menyajikan folder root", async () => {
    await register("situs");
    const fake = fakeSystem();
    const manifest = { name: "situs", type: "static", domains: ["contoh.com"], package: ["dist"], root: "dist" };
    await run("situs", SHA1, manifest, fake, { "dist/index.html": "<h1>hai</h1>" });
    const app = appPaths(env.paths, "situs");
    assert.match(fs.readFileSync(app.site, "utf8"), new RegExp(`root \\* ${app.current}/dist`));
    assert.ok(!fake.calls.some((c) => c.startsWith("systemctl restart")));
    assert.equal(fs.existsSync(app.dropIn), false);
  });

  it("tanpa index.html ditolak", async () => {
    await register("situs");
    const manifest = { name: "situs", type: "static", domains: ["contoh.com"], package: ["dist"], root: "dist" };
    await assert.rejects(run("situs", SHA1, manifest, fakeSystem(), { "dist/a.html": "x" }), /index\.html/);
  });
});

describe("releaseName", () => {
  it("waktu UTC + 12 karakter sha", () => {
    assert.equal(releaseName(new Date("2026-11-24T10:05:09.000Z"), SHA1), "20261124100509-a1b2c3d4e5f6");
  });
});
