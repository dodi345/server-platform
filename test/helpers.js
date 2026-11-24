// @ts-check
// Lingkungan test: folder sementara sebagai "/" server, dan System palsu
// (systemctl/caddy/useradd/chown dicatat saja; tar dan ssh-keygen sungguhan).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { platformPaths, realRun } from "../lib/system.js";

/** @typedef {import("../lib/system.js").System} System */

/**
 * @typedef {object} FakeOptions
 * @property {(url: string) => number} [health] status HTTP per panggilan (default 200)
 * @property {boolean} [caddyValid]
 * @property {string} [nodeVersion]
 * @property {() => string} [activeState] hasil `systemctl is-active`
 * @property {() => number} [restarts] NRestarts (restart otomatis karena crash)
 */

export function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-platform-test-"));
  const paths = platformPaths(root);
  fs.mkdirSync(path.dirname(paths.deployAuthorizedKeys), { recursive: true });
  fs.mkdirSync(path.dirname(paths.hostKey), { recursive: true });
  fs.mkdirSync(paths.caddySites, { recursive: true });
  fs.writeFileSync(paths.caddyfile, "import sites/*.caddy\n");
  const hostKey = path.join(path.dirname(paths.hostKey), "ssh_host_ed25519_key");
  realRun("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  return {
    root,
    paths,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {FakeOptions} [options] */
export function fakeSystem(options = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  let clock = Date.parse("2026-11-24T10:00:00.000Z");
  /** @type {System} */
  const sys = {
    run: (cmd, args, opts) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "tar" || cmd === "ssh-keygen") return realRun(cmd, args, opts);
      const ok = (/** @type {string} */ stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (cmd.endsWith("/node") && args[0] === "--version") return ok(`${options.nodeVersion ?? "v24.11.1"}\n`);
      if (cmd === "systemctl" && args[0] === "is-active") return ok(`${options.activeState?.() ?? "active"}\n`);
      if (cmd === "systemctl" && args[0] === "show") return ok(`${options.restarts?.() ?? 0}\n`);
      if (cmd === "caddy" && options.caddyValid === false) return { status: 1, stdout: "", stderr: "Error: adapting config" };
      if (cmd === "id") return { status: 1, stdout: "", stderr: "no such user" };
      if (cmd === "hostname") return ok("203.0.113.10 10.0.0.5\n");
      if (cmd === "journalctl") return ok("baris log aplikasi\n");
      return ok();
    },
    httpStatus: async (url) => options.health?.(url) ?? 200,
    sleep: async () => {},
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    log: (message) => logs.push(message),
  };
  return { sys, calls, logs };
}

/**
 * Buat paket tar.gz seperti hasil workflow: deploy.json + file.
 * @param {string} dir folder kerja
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, string>} files path relatif → isi
 */
export function makeArchive(dir, manifest, files) {
  const src = fs.mkdtempSync(path.join(dir, "src-"));
  fs.writeFileSync(path.join(src, "deploy.json"), JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    fs.writeFileSync(path.join(src, file), content);
  }
  const archive = path.join(dir, `${path.basename(src)}.tgz`);
  const result = realRun("tar", ["-czf", archive, "-C", src, "."]);
  if (result.status !== 0) throw new Error(result.stderr);
  return archive;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [overrides]
 */
export function nodeManifest(name, overrides = {}) {
  return {
    name,
    type: "node",
    domains: [`${name}.stackfolio.web.id`],
    node: "24",
    build: "npm ci && npm run build",
    package: ["dist", "package.json"],
    port: 4300,
    start: ["node", "dist/server.js"],
    health: "/api/health",
    shared: ["data"],
    ...overrides,
  };
}

export const NODE_FILES = { "dist/server.js": "console.log('hi')\n", "package.json": "{}\n" };
