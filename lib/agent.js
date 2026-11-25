// @ts-check
// Agent: pintu sempit untuk panel (atau app lain yang diberi akses lewat `app agent-access`).
// Dijalankan systemd sebagai root, satu proses per permintaan (socket activation), lewat socket
// /run/server-platform/agent.sock yang hanya bisa dibuka grup `platform-agent`.
//
// Hanya operasi di OPERATIONS yang ada. Tidak ada register/remove/exec, tidak ada perintah bebas,
// dan tidak ada operasi yang mengembalikan NILAI env (hanya nama variabel).
import fs from "node:fs";
import { backupPlan, readBackupConfig, readBackupState } from "./backup.js";
import { DeployError, restartApp, rollback } from "./deploy.js";
import { checkEnvFile, envValueProblem, missingEnv, setEnvValue, unsetEnvValue } from "./envfile.js";
import { appPaths, isRegistered, listAppNames, readActiveManifest, readState } from "./registry.js";

/** @typedef {import("./system.js").System} System */
/** @typedef {import("./system.js").PlatformPaths} PlatformPaths */

export const OPERATIONS = ["list", "status", "logs", "restart", "rollback", "env-keys", "env-set", "env-unset"];
/** Operasi yang mengubah sesuatu: selalu dicatat ke journald. */
const MUTATING = new Set(["restart", "rollback", "env-set", "env-unset"]);
const ACTOR_RE = /^[A-Za-z0-9 ._@+-]{1,80}$/;
const MAX_LOG_LINES = 1000;

export class AgentError extends Error {}

/**
 * @typedef {object} AgentContext
 * @property {PlatformPaths} paths
 * @property {System} sys
 * @property {number} [healthTimeoutMs]
 * @property {number} [stableMs]
 */

/**
 * Properti systemd sebuah unit (KEY=VALUE per baris).
 * @param {System} sys
 * @param {string} unit
 */
function unitProperties(sys, unit) {
  const result = sys.run("systemctl", [
    "show",
    unit,
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "NRestarts",
    "-p",
    "MemoryCurrent",
    "-p",
    "CPUUsageNSec",
    "-p",
    "ActiveEnterTimestamp",
  ]);
  /** @type {Record<string, string>} */
  const props = {};
  for (const line of result.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const number = (/** @type {string | undefined} */ value) =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  return {
    active: props.ActiveState ?? "unknown",
    sub: props.SubState ?? "unknown",
    restarts: number(props.NRestarts) ?? 0,
    memoryBytes: number(props.MemoryCurrent),
    cpuNs: number(props.CPUUsageNSec),
    since: props.ActiveEnterTimestamp || null,
  };
}

/**
 * Status backup off-site satu app (v1.5). null = backup belum diatur di server.
 * Tidak pernah mengembalikan isi config (kredensial R2).
 * @param {AgentContext} ctx
 * @param {string} name
 */
function backupSummary(ctx, name) {
  let config;
  try {
    config = readBackupConfig(ctx.paths);
  } catch {
    config = null;
  }
  if (config === null) return null;
  const last = readBackupState(ctx.paths).apps[name] ?? null;
  return {
    enabled: backupPlan(ctx.paths, name, config) !== null,
    lastAt: last?.at ?? null,
    ok: last?.ok ?? null,
    bytes: last?.bytes ?? null,
    error: last?.error ?? null,
    lastSuccessAt: last?.lastSuccessAt ?? null,
  };
}

/**
 * @param {AgentContext} ctx
 * @param {string} name
 */
function appSummary(ctx, name) {
  const app = appPaths(ctx.paths, name);
  const manifest = readActiveManifest(ctx.paths, name);
  const state = readState(app, name);
  return {
    name,
    type: manifest?.type ?? null,
    domains: manifest?.domains ?? [],
    port: manifest?.type === "node" ? manifest.port : null,
    health: manifest?.type === "node" ? manifest.health : null,
    memoryLimit: manifest?.type === "node" ? manifest.memory : null,
    current: state.current,
    previous: state.previous,
    // Hasil deploy/rollback terakhir (termasuk yang gagal): panel memakainya untuk peringatan.
    lastDeploy: state.history.at(-1) ?? null,
    backup: backupSummary(ctx, name),
    unit: manifest?.type === "node" ? unitProperties(ctx.sys, app.unit) : null,
  };
}

/**
 * @param {AgentContext} ctx
 * @param {unknown} name
 */
function requireApp(ctx, name) {
  if (typeof name !== "string" || !isRegistered(ctx.paths, name)) throw new AgentError("app tidak terdaftar");
  return name;
}

/** @param {string} file */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} file
 * @param {string} text
 */
function writeEnv(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Jalankan satu permintaan. Mengembalikan { ok: true, data } atau { ok: false, error }.
 * @param {unknown} request
 * @param {AgentContext} ctx
 */
export async function handleRequest(request, ctx) {
  try {
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new AgentError("permintaan harus objek JSON");
    const req = /** @type {Record<string, unknown>} */ (request);
    const op = req.op;
    if (typeof op !== "string" || !OPERATIONS.includes(op)) throw new AgentError("operasi tidak dikenal");
    const actor = typeof req.actor === "string" && ACTOR_RE.test(req.actor) ? req.actor : "tanpa-nama";
    const data = await dispatch(op, req, ctx);
    if (MUTATING.has(op)) {
      const key = typeof req.key === "string" ? ` ${req.key}` : "";
      ctx.sys.log(`[agent] ${op} ${String(req.name)}${key} oleh ${actor}`);
    }
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof AgentError || error instanceof DeployError || error instanceof RangeError
      ? error.message
      : "kesalahan internal agent";
    if (!(error instanceof AgentError || error instanceof DeployError || error instanceof RangeError)) {
      ctx.sys.log(`[agent] error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: false, error: message };
  }
}

/**
 * @param {string} op
 * @param {Record<string, unknown>} req
 * @param {AgentContext} ctx
 */
async function dispatch(op, req, ctx) {
  const { paths, sys } = ctx;
  switch (op) {
    case "list":
      return listAppNames(paths).map((name) => appSummary(ctx, name));

    case "status": {
      const name = requireApp(ctx, req.name);
      const app = appPaths(paths, name);
      return { ...appSummary(ctx, name), history: readState(app, name).history.slice(-20) };
    }

    case "logs": {
      const name = requireApp(ctx, req.name);
      const lines = typeof req.lines === "number" && Number.isInteger(req.lines) ? Math.min(Math.max(req.lines, 1), MAX_LOG_LINES) : 200;
      const result = sys.run("journalctl", ["-u", appPaths(paths, name).unit, "-n", String(lines), "--no-pager", "-o", "json"]);
      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            const entry = JSON.parse(line);
            const message = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString("utf8") : String(entry.MESSAGE ?? "");
            return {
              time: new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString(),
              priority: Number(entry.PRIORITY ?? 6),
              message,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    case "restart": {
      const name = requireApp(ctx, req.name);
      await restartApp({ ...ctx, name });
      return { restarted: name };
    }

    case "rollback": {
      const name = requireApp(ctx, req.name);
      await rollback({ ...ctx, name });
      return { rolledBack: name };
    }

    case "env-keys": {
      const name = requireApp(ctx, req.name);
      const text = readText(appPaths(paths, name).env);
      const manifest = readActiveManifest(paths, name);
      const required = manifest?.type === "node" ? manifest.required_env : [];
      return { keys: checkEnvFile(text).keys, required, missing: missingEnv(text, required) };
    }

    case "env-set": {
      const name = requireApp(ctx, req.name);
      const key = typeof req.key === "string" ? req.key : "";
      const problem = envValueProblem(key, req.value);
      if (problem !== null) throw new AgentError(problem);
      const file = appPaths(paths, name).env;
      writeEnv(file, setEnvValue(readText(file), key, /** @type {string} */ (req.value)));
      return { key };
    }

    case "env-unset": {
      const name = requireApp(ctx, req.name);
      const key = typeof req.key === "string" ? req.key : "";
      const file = appPaths(paths, name).env;
      writeEnv(file, unsetEnvValue(readText(file), key));
      return { key };
    }

    default:
      throw new AgentError("operasi tidak dikenal");
  }
}
