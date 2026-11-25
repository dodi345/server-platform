// @ts-check
// Backup off-site ke R2: per app, file yang ditulis di deploy.json "backup" (SQLite disnapshot
// dengan API backup SQLite sebagai user app) + .env, dikemas tar.gz, dienkripsi ke kunci publik
// (lib/backup-crypto.js), diunggah, lalu backup lama dibuang sesuai retensi (lib/retention.js).
// Restore dan verify butuh kunci privat yang hanya dipegang pemilik.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptFile, encryptFile, parsePrivateKey } from "./backup-crypto.js";
import { appPaths, listAppNames, readActiveManifest, readState } from "./registry.js";
import { DEFAULT_RETENTION, backupTime, planRetention } from "./retention.js";
import { createS3 } from "./s3.js";
import { must } from "./system.js";

/** @typedef {import("./system.js").System} System */
/** @typedef {import("./system.js").PlatformPaths} PlatformPaths */
/** @typedef {import("./s3.js").S3Client} S3Client */

export class BackupError extends Error {}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
/** Batas satu arsip (diunggah sekaligus; RAM server 1 GB). */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_SCRIPT = fileURLToPath(new URL("./sqlite-snapshot.js", import.meta.url));

/**
 * @typedef {object} BackupConfig
 * @property {string} endpoint
 * @property {string} bucket
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} region
 * @property {string} publicKey
 * @property {boolean} includeEnv
 * @property {import("./retention.js").RetentionPolicy} retention
 */

/**
 * @typedef {object} AppBackupResult
 * @property {string} at waktu ISO
 * @property {boolean} ok
 * @property {string | null} key
 * @property {number | null} bytes
 * @property {string[]} warnings
 * @property {string | null} error
 * @property {string | null} lastSuccessAt
 */

/**
 * @typedef {object} BackupContext
 * @property {PlatformPaths} paths
 * @property {System} sys
 * @property {(config: BackupConfig) => S3Client} [s3]
 * @property {(source: string, target: string, user: string) => SnapshotResult} [snapshot]
 */

/** @typedef {{ ok: boolean, integrity?: string, bytes?: number, error?: string }} SnapshotResult */

// ---- Config dan state ---------------------------------------------------------------------

/**
 * @param {PlatformPaths} paths
 * @returns {BackupConfig | null}
 */
export function readBackupConfig(paths) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(paths.backupConfig, "utf8"));
  } catch {
    return null;
  }
  for (const key of ["endpoint", "bucket", "accessKeyId", "secretAccessKey", "publicKey"]) {
    if (typeof raw?.[key] !== "string" || raw[key] === "") throw new BackupError(`config backup rusak: ${key} kosong`);
  }
  return {
    endpoint: raw.endpoint,
    bucket: raw.bucket,
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    region: typeof raw.region === "string" ? raw.region : "auto",
    publicKey: raw.publicKey,
    includeEnv: raw.includeEnv !== false,
    retention: { ...DEFAULT_RETENTION, ...(raw.retention ?? {}) },
  };
}

/**
 * @param {PlatformPaths} paths
 * @param {BackupConfig} config
 */
export function writeBackupConfig(paths, config) {
  fs.mkdirSync(path.dirname(paths.backupConfig), { recursive: true, mode: 0o700 });
  const tmp = `${paths.backupConfig}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, paths.backupConfig);
}

/**
 * @param {PlatformPaths} paths
 * @returns {{ lastRun: { at: string, ok: boolean } | null, apps: Record<string, AppBackupResult> }}
 */
export function readBackupState(paths) {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.backupState, "utf8"));
    return { lastRun: raw.lastRun ?? null, apps: raw.apps ?? {} };
  } catch {
    return { lastRun: null, apps: {} };
  }
}

/**
 * @param {PlatformPaths} paths
 * @param {ReturnType<typeof readBackupState>} state
 */
function writeBackupState(paths, state) {
  fs.mkdirSync(path.dirname(paths.backupState), { recursive: true, mode: 0o700 });
  const tmp = `${paths.backupState}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, paths.backupState);
}

/** Endpoint dari URL lengkap atau account ID saja. */
export function normalizeEndpoint(/** @type {string} */ input) {
  const value = input.trim().replace(/\/+$/, "");
  if (/^[0-9a-f]{32}$/i.test(value)) return `https://${value.toLowerCase()}.r2.cloudflarestorage.com`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BackupError("endpoint harus URL https://<account-id>.r2.cloudflarestorage.com atau account ID");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search) {
    throw new BackupError("endpoint: https://<account-id>.r2.cloudflarestorage.com (tanpa nama bucket/path)");
  }
  return url.origin;
}

// ---- Apa yang di-backup -------------------------------------------------------------------

/**
 * File (deploy.json "backup") dan .env satu app. null = tidak ada yang perlu di-backup.
 * @param {PlatformPaths} paths
 * @param {string} name
 * @param {{ includeEnv: boolean }} config
 */
export function backupPlan(paths, name, config) {
  const manifest = readActiveManifest(paths, name);
  const files = manifest?.type === "node" ? manifest.backup : [];
  const env = config.includeEnv && manifest?.type === "node" && fs.existsSync(appPaths(paths, name).env);
  if (files.length === 0 && !env) return null;
  return { files, env };
}

/** apps/<app>/2026-11-25T20-00-03Z.tar.gz.spb */
export function objectKey(/** @type {string} */ app, /** @type {Date} */ date) {
  return `apps/${app}/${date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}.tar.gz.spb`;
}

/** @param {string} file */
function isSqlite(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {string} file */
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Snapshot SQLite di proses terpisah, sebagai user app kalau dijalankan root.
 * @param {System} sys
 * @returns {(source: string, target: string, user: string) => SnapshotResult}
 */
export function realSnapshot(sys) {
  return (source, target, user) => {
    /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
    const options = { encoding: "utf8", timeout: 10 * 60_000, cwd: "/" };
    if (process.getuid?.() === 0) {
      options.uid = Number(must(sys.run, "id", ["-u", user]).stdout.trim());
      options.gid = Number(must(sys.run, "id", ["-g", user]).stdout.trim());
    }
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SNAPSHOT_SCRIPT, source, target], options);
    try {
      return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      return { ok: false, error: (result.stderr || result.error?.message || "snapshot gagal").trim().slice(-300) };
    }
  };
}

/**
 * @param {PlatformPaths} paths
 * @param {string} prefix
 */
function workDir(paths, prefix) {
  // 711: user app bisa lewat ke folder snapshot miliknya, tapi tidak bisa melihat isi folder.
  fs.mkdirSync(paths.backupTmp, { recursive: true, mode: 0o711 });
  fs.chmodSync(paths.backupTmp, 0o711);
  const dir = fs.mkdtempSync(path.join(paths.backupTmp, `${prefix}-`));
  fs.chmodSync(dir, 0o711);
  return dir;
}

// ---- Backup -------------------------------------------------------------------------------

/**
 * Backup satu app ke R2. Tidak melempar error: hasilnya dikembalikan (dan dicatat ke state).
 * @param {BackupContext} ctx
 * @param {BackupConfig} config
 * @param {S3Client} s3
 * @param {string} name
 * @param {{ files: string[], env: boolean }} plan
 * @returns {Promise<Omit<AppBackupResult, "lastSuccessAt">>}
 */
async function backupApp(ctx, config, s3, name, plan) {
  const { paths, sys } = ctx;
  const app = appPaths(paths, name);
  const at = sys.now();
  /** @type {string[]} */
  const warnings = [];
  const work = workDir(paths, name);
  try {
    const stage = path.join(work, "stage");
    const snapDir = path.join(work, "snap");
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.mkdirSync(path.join(stage, "files"), { mode: 0o700 });
    fs.mkdirSync(snapDir, { mode: 0o700 });
    if (process.getuid?.() === 0) must(sys.run, "chown", [`${app.user}:${app.user}`, snapDir]);
    const snapshot = ctx.snapshot ?? realSnapshot(sys);

    /** @type {{ path: string, bytes: number, sha256: string, sqlite: boolean }[]} */
    const files = [];
    plan.files.forEach((rel, index) => {
      const source = path.join(app.shared, rel);
      const target = path.join(stage, "files", rel);
      let stat;
      try {
        stat = fs.lstatSync(source);
      } catch {
        warnings.push(`${rel}: tidak ada`);
        return;
      }
      if (stat.isSymbolicLink()) {
        warnings.push(`${rel}: symlink dilewati`);
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (stat.isDirectory()) {
        fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
        files.push({ path: `${rel}/`, bytes: 0, sha256: "", sqlite: false });
        return;
      }
      if (isSqlite(source)) {
        const snap = path.join(snapDir, `${index}.db`);
        const result = snapshot(source, snap, app.user);
        if (!result.ok) throw new BackupError(`${rel}: snapshot SQLite gagal (${result.error ?? result.integrity ?? "?"})`);
        fs.renameSync(snap, target);
      } else {
        fs.copyFileSync(source, target);
      }
      files.push({ path: rel, bytes: fs.statSync(target).size, sha256: sha256File(target), sqlite: isSqlite(target) });
    });

    if (plan.env) {
      fs.mkdirSync(path.join(stage, "env"), { mode: 0o700 });
      fs.copyFileSync(app.env, path.join(stage, "env", ".env"));
      fs.chmodSync(path.join(stage, "env", ".env"), 0o600);
    }
    const state = readState(app, name);
    fs.writeFileSync(
      path.join(stage, "manifest.json"),
      `${JSON.stringify({ format: 1, app: name, createdAt: at.toISOString(), release: state.current, files, env: plan.env, warnings }, null, 2)}\n`,
    );

    const archive = path.join(work, "backup.tar.gz");
    must(sys.run, "tar", ["-czf", archive, "-C", stage, "."]);
    const encrypted = `${archive}.spb`;
    await encryptFile(archive, encrypted, config.publicKey);
    const bytes = fs.statSync(encrypted).size;
    if (bytes > MAX_ARCHIVE_BYTES) throw new BackupError(`arsip ${Math.round(bytes / 1e6)} MB melebihi batas ${MAX_ARCHIVE_BYTES / 1e6} MB`);
    const key = objectKey(name, at);
    await s3.putObject(key, fs.readFileSync(encrypted));

    // Retensi, mulai dari yang tertua. Gagal menghapus (mis. bucket lock) hanya jadi catatan.
    const existing = (await s3.listObjects(`apps/${name}/`)).map((o) => o.key);
    if (!existing.includes(key)) existing.push(key);
    const { remove } = planRetention(existing, at.getTime(), config.retention);
    for (const old of [...remove].reverse()) {
      try {
        await s3.deleteObject(old);
      } catch (error) {
        warnings.push(`tidak bisa menghapus backup lama ${path.basename(old)}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    return { at: at.toISOString(), ok: true, key, bytes, warnings, error: null };
  } catch (error) {
    return { at: at.toISOString(), ok: false, key: null, bytes: null, warnings, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Backup semua app (atau satu). Hasil dicatat ke state (dibaca agent → panel).
 * @param {BackupContext} ctx
 * @param {{ app?: string }} [opts]
 * @returns {Promise<Record<string, AppBackupResult>>}
 */
export async function runBackup(ctx, opts = {}) {
  const config = readBackupConfig(ctx.paths);
  if (config === null) throw new BackupError("backup belum diatur: sudo app backup-setup");
  const s3 = (ctx.s3 ?? createS3)(config);
  const names = opts.app ? [opts.app] : listAppNames(ctx.paths);
  const state = readBackupState(ctx.paths);
  /** @type {Record<string, AppBackupResult>} */
  const results = {};
  for (const name of names) {
    const plan = backupPlan(ctx.paths, name, config);
    if (plan === null) {
      if (opts.app) throw new BackupError(`${name}: tidak ada yang di-backup (isi "backup" di deploy.json)`);
      continue;
    }
    const result = await backupApp(ctx, config, s3, name, plan);
    const lastSuccessAt = result.ok ? result.at : (state.apps[name]?.lastSuccessAt ?? null);
    results[name] = { ...result, lastSuccessAt };
    state.apps[name] = results[name];
    const size = result.bytes === null ? "" : ` (${(result.bytes / 1024).toFixed(0)} KB)`;
    ctx.sys.log(result.ok ? `✓ ${name}${size} → ${result.key}` : `✗ ${name}: ${result.error}`);
    for (const warning of result.warnings) ctx.sys.log(`  ! ${warning}`);
  }
  // App yang sudah dihapus dari platform tidak dilaporkan lagi.
  for (const name of Object.keys(state.apps)) if (!listAppNames(ctx.paths).includes(name)) delete state.apps[name];
  if (!opts.app) state.lastRun = { at: ctx.sys.now().toISOString(), ok: Object.values(results).every((r) => r.ok) };
  writeBackupState(ctx.paths, state);
  return results;
}

// ---- Daftar, verify, restore --------------------------------------------------------------

/**
 * @param {S3Client} s3
 * @param {string} app
 */
export async function listBackups(s3, app) {
  return (await s3.listObjects(`apps/${app}/`))
    .map((o) => ({ ...o, time: backupTime(o.key) }))
    .filter((o) => o.time !== null)
    .sort((a, b) => /** @type {number} */ (b.time) - /** @type {number} */ (a.time));
}

/**
 * Unduh + buka satu backup ke folder kerja (root-only). Isi dicek dengan sha256 di manifest.
 * @param {BackupContext} ctx
 * @param {S3Client} s3
 * @param {string} app
 * @param {string} which "latest" atau nama objek / nama file
 * @param {string} privateKey
 */
export async function openBackup(ctx, s3, app, which, privateKey) {
  const config = readBackupConfig(ctx.paths);
  if (config && parsePrivateKey(privateKey).publicKey !== config.publicKey) {
    throw new BackupError("kunci privat ini bukan pasangan kunci publik di config backup server");
  }
  const backups = await listBackups(s3, app);
  const chosen = which === "latest" ? backups[0] : backups.find((b) => b.key === which || path.basename(b.key) === which);
  if (!chosen) throw new BackupError(which === "latest" ? `belum ada backup untuk ${app}` : `backup "${which}" tidak ditemukan`);
  const work = workDir(ctx.paths, `restore-${app}`);
  try {
    const encrypted = path.join(work, "backup.tar.gz.spb");
    fs.writeFileSync(encrypted, await s3.getObject(chosen.key), { mode: 0o600 });
    const archive = path.join(work, "backup.tar.gz");
    await decryptFile(encrypted, archive, privateKey);
    fs.chmodSync(work, 0o700);
    const out = path.join(work, "isi");
    fs.mkdirSync(out, { mode: 0o700 });
    must(ctx.sys.run, "tar", ["-xzf", archive, "-C", out, "--no-same-owner"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    if (manifest.app !== app) throw new BackupError(`isi backup milik app "${manifest.app}", bukan "${app}"`);
    /** @type {string[]} */
    const problems = [];
    for (const file of manifest.files) {
      if (file.path.endsWith("/")) continue;
      const restored = path.join(out, "files", file.path);
      if (!fs.existsSync(restored)) problems.push(`${file.path}: tidak ada di arsip`);
      else if (sha256File(restored) !== file.sha256) problems.push(`${file.path}: checksum tidak cocok`);
    }
    return { key: chosen.key, work, dir: out, manifest, problems };
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Cek satu backup: bisa dibuka, checksum cocok, SQLite lolos integrity_check. Tidak mengubah apa pun.
 * @param {BackupContext} ctx
 * @param {S3Client} s3
 * @param {string} app
 * @param {string} which
 * @param {string} privateKey
 */
export async function verifyBackup(ctx, s3, app, which, privateKey) {
  const opened = await openBackup(ctx, s3, app, which, privateKey);
  try {
    const problems = [...opened.problems];
    const snapshot = ctx.snapshot ?? realSnapshot(ctx.sys);
    for (const file of opened.manifest.files) {
      if (!file.sqlite) continue;
      const copy = path.join(opened.work, `cek-${crypto.randomBytes(4).toString("hex")}.db`);
      const result = snapshot(path.join(opened.dir, "files", file.path), copy, "root");
      if (!result.ok) problems.push(`${file.path}: ${result.error ?? `integrity_check: ${result.integrity}`}`);
    }
    return { key: opened.key, manifest: opened.manifest, problems };
  } finally {
    fs.rmSync(opened.work, { recursive: true, force: true });
  }
}

/**
 * Pulihkan file (dan .env kalau diminta) dari satu backup ke app. File lama tidak dihapus:
 * dipindah ke <file>.sebelum-restore-<waktu>. App dihentikan selama file diganti.
 * @param {BackupContext} ctx
 * @param {S3Client} s3
 * @param {string} app
 * @param {string} which
 * @param {string} privateKey
 * @param {{ withEnv: boolean }} opts
 */
export async function restoreBackup(ctx, s3, app, which, privateKey, opts) {
  const { paths, sys } = ctx;
  const target = appPaths(paths, app);
  const opened = await openBackup(ctx, s3, app, which, privateKey);
  try {
    if (opened.problems.length > 0) throw new BackupError(`backup rusak, restore dibatalkan:\n  - ${opened.problems.join("\n  - ")}`);
    const stamp = sys.now().toISOString().replace(/[:.]/g, "-");
    const manifestNow = readActiveManifest(paths, app);
    if (manifestNow?.type === "node") must(sys.run, "systemctl", ["stop", target.unit]);
    /** @type {string[]} */
    const restored = [];
    for (const file of opened.manifest.files) {
      const rel = file.path.replace(/\/$/, "");
      const dest = path.join(target.shared, rel);
      if (!path.resolve(dest).startsWith(`${path.resolve(target.shared)}${path.sep}`)) throw new BackupError(`${rel}: path di luar folder shared`);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (fs.existsSync(dest + suffix)) fs.renameSync(dest + suffix, `${dest}${suffix}.sebelum-restore-${stamp}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(path.join(opened.dir, "files", rel), dest, { recursive: true, verbatimSymlinks: true });
      if (process.getuid?.() === 0) must(sys.run, "chown", ["-R", `${target.user}:${target.user}`, dest]);
      restored.push(rel);
    }
    if (opts.withEnv && opened.manifest.env) {
      if (fs.existsSync(target.env)) fs.renameSync(target.env, `${target.env}.sebelum-restore-${stamp}`);
      fs.copyFileSync(path.join(opened.dir, "env", ".env"), target.env);
      fs.chmodSync(target.env, 0o600);
      restored.push(".env");
    }
    return { key: opened.key, restored, stamp, startNeeded: manifestNow?.type === "node" };
  } finally {
    fs.rmSync(opened.work, { recursive: true, force: true });
  }
}
