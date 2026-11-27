// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleRequest, OPERATIONS } from "../lib/agent.js";
import { main } from "../lib/cli.js";
import { deploy } from "../lib/deploy.js";
import { envValueProblem, formatEnvLine, missingEnv, setEnvValue, unsetEnvValue } from "../lib/envfile.js";
import { appPaths } from "../lib/registry.js";
import {
  createTestEnv,
  fakeSystem,
  makeArchive,
  NODE_FILES,
  nodeManifest,
  PYTHON_FILES,
  pythonManifest,
} from "./helpers.js";

/** @type {ReturnType<typeof createTestEnv>} */
let env;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

async function registerAndDeploy(name = "words") {
  await main(["register", name], { paths: env.paths, sys: fakeSystem().sys });
  fs.writeFileSync(appPaths(env.paths, name).env, "TOKEN=rahasia-sekali\n# komentar\nLAIN=1\n");
  const archive = makeArchive(env.root, nodeManifest(name, { required_env: ["TOKEN"] }), NODE_FILES);
  await deploy({
    paths: env.paths,
    sys: fakeSystem().sys,
    name,
    sha: "abcdef1234",
    archive,
    repository: "dodi345/contoh",
    stableMs: 0,
  });
}

/** @param {unknown} request @param {Parameters<typeof fakeSystem>[0]} [options] */
async function call(request, options) {
  const fake = fakeSystem(options);
  const response = await handleRequest(request, { paths: env.paths, sys: fake.sys, healthTimeoutMs: 5_000, stableMs: 0 });
  return { response, fake };
}

describe("agent: permintaan yang ditolak", () => {
  it("operasi di luar daftar, bukan objek, atau app tidak terdaftar", async () => {
    assert.deepEqual(OPERATIONS, ["list", "status", "logs", "restart", "rollback", "env-keys", "env-set", "env-unset"]);
    for (const request of [null, [], "list", { op: "exec", name: "words" }, { op: "register", name: "x" }, { op: "env-get" }]) {
      const { response } = await call(request);
      assert.equal(response.ok, false, JSON.stringify(request));
    }
    const { response } = await call({ op: "status", name: "hantu" });
    assert.deepEqual(response, { ok: false, error: "app tidak terdaftar" });
  });

  it("nama variabel dan nilai env divalidasi", async () => {
    await registerAndDeploy();
    for (const request of [
      { op: "env-set", name: "words", key: "1SALAH", value: "x" },
      { op: "env-set", name: "words", key: "A B", value: "x" },
      { op: "env-set", name: "words", key: "OK", value: "baris\nbaru" },
      { op: "env-set", name: "words", key: "OK", value: 5 },
      { op: "env-unset", name: "words", key: "../x" },
    ]) {
      const { response } = await call(request);
      assert.equal(response.ok, false, JSON.stringify(request));
    }
  });
});

describe("agent: operasi", () => {
  it("list dan status: info app + properti systemd + repo commit, tanpa isi env", async () => {
    await registerAndDeploy();
    const { response } = await call({ op: "list" });
    assert.equal(response.ok, true);
    const [app] = /** @type {any[]} */ (response.data);
    assert.equal(app.name, "words");
    assert.equal(app.port, 4300);
    assert.equal(app.current.sha, "abcdef1234");
    assert.equal(app.current.repository, "dodi345/contoh");
    assert.equal(app.lastDeploy.result, "ok");
    assert.equal(app.lastDeploy.sha, "abcdef1234");
    assert.equal(app.unit.active, "active");
    assert.equal(app.unit.memoryBytes, 52428800);
    assert.doesNotMatch(JSON.stringify(response), /rahasia/);

    const status = await call({ op: "status", name: "words" });
    assert.equal(/** @type {any} */ (status.response.data).history.at(-1).result, "ok");
  });

  it("app python tampil seperti app node: port, health, batas RAM, properti systemd", async () => {
    await main(["register", "tools"], { paths: env.paths, sys: fakeSystem().sys });
    const archive = makeArchive(env.root, pythonManifest("tools", { memory: "350M" }), PYTHON_FILES);
    await deploy({ paths: env.paths, sys: fakeSystem().sys, name: "tools", sha: "abcdef1234", archive, stableMs: 0 });
    const { response } = await call({ op: "list" });
    const [app] = /** @type {any[]} */ (response.data);
    assert.equal(app.type, "python");
    assert.equal(app.port, 4700);
    assert.equal(app.health, "/api/health");
    assert.equal(app.memoryLimit, "350M");
    assert.equal(app.unit.active, "active");
  });

  it("env-keys: nama variabel + yang wajib belum diisi, tanpa nilai", async () => {
    await registerAndDeploy();
    const { response } = await call({ op: "env-keys", name: "words" });
    assert.deepEqual(response, { ok: true, data: { keys: ["TOKEN", "LAIN"], required: ["TOKEN"], missing: [] } });
  });

  it("env-set mengganti/menambah, env-unset menghapus; file tetap 600; dicatat tanpa nilai", async () => {
    await registerAndDeploy();
    const file = appPaths(env.paths, "words").env;
    const set = await call({ op: "env-set", name: "words", key: "TOKEN", value: "baru dengan spasi", actor: "dodi" });
    assert.equal(set.response.ok, true);
    await call({ op: "env-set", name: "words", key: "BARU", value: "x" });
    await call({ op: "env-unset", name: "words", key: "LAIN" });
    assert.equal(fs.readFileSync(file, "utf8"), 'TOKEN="baru dengan spasi"\n# komentar\nBARU=x\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(set.fake.logs.join("\n"), /\[agent\] env-set words TOKEN oleh dodi/);
    assert.doesNotMatch(set.fake.logs.join("\n"), /spasi/);
  });

  it("restart dan rollback memakai alur deploy yang sama (health check)", async () => {
    await registerAndDeploy();
    const restart = await call({ op: "restart", name: "words" });
    assert.equal(restart.response.ok, true);
    assert.ok(restart.fake.calls.includes("systemctl restart app@words.service"));
    const failing = await call({ op: "restart", name: "words" }, { health: () => 0 });
    assert.equal(failing.response.ok, false);
    const rollback = await call({ op: "rollback", name: "words" });
    assert.deepEqual(rollback.response, { ok: false, error: "tidak ada release sebelumnya untuk rollback" });
  });

  it("logs: entri journald (JSON) → waktu, prioritas, pesan", async () => {
    await registerAndDeploy();
    const fake = fakeSystem();
    const original = fake.sys.run;
    /** @type {string[]} */
    const journal = [];
    fake.sys.run = (cmd, args, opts) =>
      cmd === "journalctl" && journal.push(args.join(" "))
        ? {
            status: 0,
            stderr: "",
            stdout: `${JSON.stringify({ __REALTIME_TIMESTAMP: "1795600000000000", PRIORITY: "3", MESSAGE: "gagal konek" })}\nbukan json\n`,
          }
        : original(cmd, args, opts);
    const response = await handleRequest({ op: "logs", name: "words", lines: 5000 }, { paths: env.paths, sys: fake.sys });
    assert.deepEqual(response, {
      ok: true,
      data: [{ time: new Date(1795600000000).toISOString(), priority: 3, message: "gagal konek" }],
    });
    assert.ok(journal[0]?.startsWith("-u app@words.service -n 1000 "));
  });
});

describe("env file", () => {
  it("formatEnvLine: nilai biasa tanpa kutip, nilai khusus dengan kutip dan escape", () => {
    assert.equal(formatEnvLine("A", "https://x.y/z"), "A=https://x.y/z");
    assert.equal(formatEnvLine("A", "https://x.y/z?q=1"), 'A="https://x.y/z?q=1"');
    assert.equal(formatEnvLine("A", "abc-123"), "A=abc-123");
    assert.equal(formatEnvLine("A", 'a "b" \\c'), 'A="a \\"b\\" \\\\c"');
  });

  it("setEnvValue mempertahankan baris lain; nilai dobel digabung jadi satu", () => {
    assert.equal(setEnvValue("A=1\nB=2\nA=3\n", "A", "9"), "A=9\nB=2\n");
    assert.equal(setEnvValue("", "A", "1"), "A=1\n");
    assert.equal(unsetEnvValue("A=1\n\nB=2\n", "A"), "\nB=2\n");
    assert.equal(unsetEnvValue("A=1\n", "A"), "");
  });

  it("nilai kosong atau kutip kosong = belum diisi; validasi tanpa membocorkan nilai", () => {
    assert.deepEqual(missingEnv('A=""\nB=\'\'\nC=x\n', ["A", "B", "C"]), ["A", "B"]);
    assert.equal(envValueProblem("A", "x".repeat(9000))?.includes("x".repeat(20)), false);
  });
});

describe("CLI: env-set, env-unset, agent-access", () => {
  it("env-set membaca nilai dari stdin (tidak tampil), env-unset menghapus", async () => {
    await registerAndDeploy();
    const fake = fakeSystem();
    const ctx = { paths: env.paths, sys: fake.sys, readSecret: async () => "nilai-rahasia" };
    assert.equal(await main(["env-set", "words", "API_KEY"], ctx), 0);
    assert.match(fs.readFileSync(appPaths(env.paths, "words").env, "utf8"), /^API_KEY=nilai-rahasia$/m);
    assert.doesNotMatch(fake.logs.join("\n"), /nilai-rahasia/);
    assert.equal(await main(["env-unset", "words", "API_KEY"], ctx), 0);
    assert.doesNotMatch(fs.readFileSync(appPaths(env.paths, "words").env, "utf8"), /API_KEY/);
    assert.equal(await main(["env-set", "words", "BAD KEY"], ctx), 1);
  });

  it("agent-access menambahkan user app ke grup platform-agent", async () => {
    await registerAndDeploy();
    const fake = fakeSystem();
    assert.equal(await main(["agent-access", "words"], { paths: env.paths, sys: fake.sys }), 0);
    assert.ok(fake.calls.includes("usermod -aG platform-agent app-words"));
    assert.equal(await main(["agent-access", "hantu"], { paths: env.paths, sys: fakeSystem().sys }), 1);
  });
});
