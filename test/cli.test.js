// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { execArgs, main } from "../lib/cli.js";
import { deploy } from "../lib/deploy.js";
import { appPaths } from "../lib/registry.js";
import { createTestEnv, fakeSystem, makeArchive, NODE_FILES, nodeManifest } from "./helpers.js";

/** @type {ReturnType<typeof createTestEnv>} */
let env;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

/** @param {import("../lib/cli.js").CliContext["edit"]} [edit] @param {string} [answer] */
function ctx(edit, answer) {
  const fake = fakeSystem();
  return {
    fake,
    context: { paths: env.paths, sys: fake.sys, ...(edit ? { edit } : {}), ask: async () => answer ?? "" },
  };
}

async function registerAndDeploy() {
  await main(["register", "words"], ctx().context);
  const archive = makeArchive(env.root, nodeManifest("words", { required_env: ["TOKEN"] }), NODE_FILES);
  fs.writeFileSync(appPaths(env.paths, "words").env, "TOKEN=rahasia-sekali\n");
  await deploy({ paths: env.paths, sys: fakeSystem().sys, name: "words", sha: "abcdef1", archive, stableMs: 0 });
}

describe("app list", () => {
  it("tabel dan JSON (untuk panel monitoring)", async () => {
    await registerAndDeploy();
    await main(["register", "baru"], ctx().context);
    const { fake, context } = ctx();
    assert.equal(await main(["list"], context), 0);
    const table = fake.logs.join("\n");
    assert.match(table, /^APP\s+TIPE\s+STATUS/m);
    assert.match(table, /^baru\s+-\s+belum deploy/m);
    assert.match(table, /^words\s+node\s+active\s+4300\s+abcdef1/m);

    const json = ctx();
    await main(["list", "--json"], json.context);
    const apps = JSON.parse(json.fake.logs.join("\n"));
    assert.deepEqual(
      apps.map((/** @type {{ name: string }} */ a) => a.name),
      ["baru", "words"],
    );
    assert.equal(apps[1].sha, "abcdef1");
  });
});

describe("app env", () => {
  it("--keys hanya menampilkan nama variabel, tidak pernah nilainya", async () => {
    await registerAndDeploy();
    const { fake, context } = ctx();
    await main(["env", "words", "--keys"], context);
    const output = fake.logs.join("\n");
    assert.match(output, /TOKEN/);
    assert.doesNotMatch(output, /rahasia/);
  });

  it("hasil edit valid disimpan (600); tidak valid → .env lama tetap", async () => {
    await registerAndDeploy();
    const file = appPaths(env.paths, "words").env;

    const bad = ctx((draft) => fs.writeFileSync(draft, "TOKEN=baru\nINI SALAH\n"));
    assert.equal(await main(["env", "words"], bad.context), 1);
    assert.equal(fs.readFileSync(file, "utf8"), "TOKEN=rahasia-sekali\n");
    assert.ok(bad.fake.logs.join("\n").includes("TIDAK disimpan"));

    const good = ctx((draft) => fs.writeFileSync(draft, "TOKEN=baru\nURL=https://a.b"));
    assert.equal(await main(["env", "words"], good.context), 0);
    assert.equal(fs.readFileSync(file, "utf8"), "TOKEN=baru\nURL=https://a.b\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(good.fake.logs.join("\n"), /sudo app restart words/);
    assert.deepEqual(
      fs.readdirSync(appPaths(env.paths, "words").shared).filter((f) => f.startsWith(".env.edit")),
      [],
    );
  });
});

describe("app remove", () => {
  it("konfirmasi salah → tidak ada yang dihapus", async () => {
    await registerAndDeploy();
    const { context } = ctx(undefined, "salah");
    assert.equal(await main(["remove", "words"], context), 1);
    assert.ok(fs.existsSync(appPaths(env.paths, "words").site));
  });

  it("tanpa --purge: config dan key dicabut, data tetap; --purge: semua hilang", async () => {
    await registerAndDeploy();
    const app = appPaths(env.paths, "words");
    const { fake, context } = ctx(undefined, "words");
    assert.equal(await main(["remove", "words"], context), 0);
    assert.equal(fs.existsSync(app.site), false);
    assert.equal(fs.existsSync(app.dropInDir), false);
    assert.equal(fs.readFileSync(env.paths.deployAuthorizedKeys, "utf8"), "");
    assert.ok(fs.existsSync(app.env));
    assert.ok(fake.calls.includes("systemctl disable --now --quiet app@words.service"));

    await main(["register", "words"], ctx().context);
    assert.equal(await main(["remove", "words", "--purge"], ctx(undefined, "words").context), 0);
    assert.equal(fs.existsSync(app.dir), false);
  });
});

describe("perintah lain", () => {
  it("tanpa perintah / perintah tidak dikenal → bantuan, kode 1", async () => {
    const empty = ctx();
    assert.equal(await main([], empty.context), 1);
    assert.match(empty.fake.logs.join("\n"), /Pemakaian: sudo app/);
    assert.equal(await main(["entah"], ctx().context), 1);
  });

  it("nama app tidak valid / belum terdaftar ditolak", async () => {
    assert.equal(await main(["register", "Bad Name"], ctx().context), 1);
    assert.equal(await main(["status", "hantu"], ctx().context), 1);
  });
});

describe("app exec", () => {
  it("systemd-run sebagai user app, env dari shared/.env, folder release aktif; node → path absolut", () => {
    assert.deepEqual(execArgs(env.paths, "words", ["node", "dist/cli/user-create.js", "--admin"], true), [
      "--quiet",
      "--wait",
      "--collect",
      "--pty",
      "--uid=app-words",
      "--gid=app-words",
      "--property",
      `EnvironmentFile=${appPaths(env.paths, "words").env}`,
      "--property",
      `WorkingDirectory=${appPaths(env.paths, "words").current}`,
      "--setenv=NODE_ENV=production",
      "--",
      "/usr/bin/node",
      "dist/cli/user-create.js",
      "--admin",
    ]);
    assert.equal(execArgs(env.paths, "words", ["ls"], false)[3], "--pipe");
  });

  it("tanpa perintah / app belum deploy ditolak", async () => {
    await main(["register", "words"], ctx().context);
    const noCmd = ctx();
    assert.equal(await main(["exec", "words"], noCmd.context), 1);
    assert.match(noCmd.fake.logs.join("\n"), /perintah wajib diisi/);
    const notDeployed = ctx();
    assert.equal(await main(["exec", "words", "ls"], notDeployed.context), 1);
    assert.match(notDeployed.fake.logs.join("\n"), /belum pernah di-deploy/);
  });
});
