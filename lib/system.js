// @ts-check
// Semua efek samping (perintah, HTTP, waktu, log) lewat objek System, supaya test bisa
// menggantinya tanpa menyentuh systemd/Caddy sungguhan.
import { spawnSync } from "node:child_process";
import path from "node:path";

/** @typedef {{ status: number, stdout: string, stderr: string }} RunResult */
/** @typedef {(cmd: string, args: string[], opts?: { input?: string }) => RunResult} Run */

/**
 * @typedef {object} System
 * @property {Run} run
 * @property {(url: string, timeoutMs: number) => Promise<number>} httpStatus 0 kalau gagal terhubung
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Date} now
 * @property {(message: string) => void} log
 */

/** @type {Run} */
export function realRun(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { status: 127, stdout: "", stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** @returns {System} */
export function realSystem() {
  return {
    run: realRun,
    httpStatus: async (url, timeoutMs) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
        await res.body?.cancel();
        return res.status;
      } catch {
        return 0;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log: (message) => console.log(message),
  };
}

/**
 * Jalankan perintah; lempar error kalau gagal.
 * @param {Run} run
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string }} [opts]
 */
export function must(run, cmd, args, opts) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-800);
    throw new Error(`${cmd} ${args.join(" ")} gagal (kode ${result.status})${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

/**
 * Lokasi file platform. `root` hanya diganti di test (folder sementara).
 * @param {string} [root]
 */
export function platformPaths(root = "/") {
  const at = (/** @type {string[]} */ ...parts) => path.join(root, ...parts);
  return {
    root,
    apps: at("srv", "apps"),
    caddyfile: at("etc", "caddy", "Caddyfile"),
    caddySites: at("etc", "caddy", "sites"),
    systemdDir: at("etc", "systemd", "system"),
    deployAuthorizedKeys: at("home", "deploy", ".ssh", "authorized_keys"),
    hostKey: at("etc", "ssh", "ssh_host_ed25519_key.pub"),
    backupConfig: at("etc", "server-platform", "backup.json"),
    backupState: at("var", "lib", "server-platform", "backup-state.json"),
    backupTmp: at("var", "tmp", "server-platform-backup"),
    nodeBin: "/usr/bin/node",
    /** + versi dari deploy.json, mis. /usr/bin/python3.12 (paket python3 Ubuntu). */
    pythonPrefix: "/usr/bin/python",
    deploySsh: "/usr/local/bin/app-deploy-ssh",
  };
}

/** @typedef {ReturnType<typeof platformPaths>} PlatformPaths */
