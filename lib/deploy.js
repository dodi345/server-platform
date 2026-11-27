// @ts-check
// Inti deploy: paket build (tar.gz dari GitHub Actions) → release baru → config Caddy + systemd
// → restart → health check. Gagal di tengah jalan = semua dikembalikan ke kondisi sebelumnya.
import fs from "node:fs";
import path from "node:path";
import { missingEnv } from "./envfile.js";
import { conflicts, isService, ManifestError, parseManifest } from "./manifest.js";
import {
  appPaths,
  currentRelease,
  isRegistered,
  listAppNames,
  readActiveManifest,
  readManifestIn,
  readState,
  writeState,
} from "./registry.js";
import { renderCaddySite, renderSystemdDropIn, runtimeBin } from "./render.js";
import { must } from "./system.js";

/** @typedef {import("./system.js").System} System */
/** @typedef {import("./system.js").PlatformPaths} PlatformPaths */
/** @typedef {import("./registry.js").AppPaths} AppPaths */
/** @typedef {import("./manifest.js").Manifest} Manifest */

export const SHA_RE = /^[0-9a-f]{7,40}$/;
/** Release yang disimpan (selain current dan previous). */
export const KEEP_RELEASES = 3;

export class DeployError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DeployError";
  }
}

/**
 * @typedef {object} DeployOptions
 * @property {PlatformPaths} paths
 * @property {System} sys
 * @property {number} [healthTimeoutMs] batas tunggu health check (default 60 detik)
 * @property {number} [stableMs] jeda cek ulang setelah sehat (default 5 detik)
 */

/**
 * Nama folder release: waktu UTC + sha, sehingga urutan nama = urutan waktu.
 * @param {Date} date
 * @param {string} sha
 */
export function releaseName(date, sha) {
  const stamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}-${sha.slice(0, 12)}`;
}

/**
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(file, fn) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        fs.rmSync(file, { force: true });
      }
    } catch (error) {
      if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        throw error;
      }
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        throw new DeployError("deploy lain untuk app ini sedang berjalan; coba lagi nanti");
      }
      fs.rmSync(file, { force: true }); // sisa proses yang sudah mati
    }
  }
  throw new DeployError("tidak bisa mengambil kunci deploy");
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {string | null} content null = hapus
 */
function writeOrRemove(file, content) {
  if (content === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Ganti symlink current secara atomik (null = hapus).
 * @param {AppPaths} app
 * @param {string | null} release
 */
function pointCurrent(app, release) {
  if (release === null) {
    fs.rmSync(app.current, { force: true });
    return;
  }
  const tmp = `${app.current}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join("releases", release), tmp);
  fs.renameSync(tmp, app.current);
}

/**
 * @param {PlatformPaths} paths
 * @param {string} name
 */
function activeManifestsOfOthers(paths, name) {
  /** @type {Manifest[]} */
  const result = [];
  for (const other of listAppNames(paths)) {
    if (other === name) continue;
    const manifest = readActiveManifest(paths, other);
    if (manifest !== null) result.push(manifest);
  }
  return result;
}

/**
 * Siapkan release di folder sementara: cek manifest, bentrok, env, versi Node/Python, folder shared.
 * @param {DeployOptions & { name: string, app: AppPaths, dir: string }} ctx
 * @returns {Manifest}
 */
function prepareRelease(ctx) {
  const { paths, sys, name, app, dir } = ctx;
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, "deploy.json"), "utf8")));
  } catch (error) {
    if (error instanceof ManifestError) throw new DeployError(error.message);
    throw new DeployError("deploy.json tidak ada atau bukan JSON valid di paket");
  }
  if (manifest.name !== name) {
    throw new DeployError(`deploy.json berisi name "${manifest.name}", padahal key deploy ini untuk app "${name}"`);
  }
  const clash = conflicts(manifest, activeManifestsOfOthers(paths, name));
  if (clash.length > 0) throw new DeployError(`bentrok dengan app lain:\n  - ${clash.join("\n  - ")}`);

  if (isService(manifest)) {
    const entry = manifest.start[1] ?? "";
    // python -m <modul>: modul dicari Python di vendor/ dan folder release, tidak dicek di sini.
    const isModule = manifest.type === "python" && entry === "-m";
    if (!isModule && !fs.existsSync(path.join(dir, entry))) {
      throw new DeployError(`file start "${entry}" tidak ada di paket (cek "package" di deploy.json)`);
    }
    const envText = readOrNull(app.env) ?? "";
    const missing = missingEnv(envText, manifest.required_env);
    if (missing.length > 0) {
      throw new DeployError(`env belum diisi: ${missing.join(", ")} (sudo app env ${name})`);
    }
    checkRuntime(paths, sys, manifest);
    for (const shared of manifest.shared) {
      const inRelease = path.join(dir, shared);
      if (fs.existsSync(inRelease)) {
        throw new DeployError(`folder "${shared}" ada di paket, padahal itu folder shared (data)`);
      }
      const target = path.join(app.shared, shared);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
        must(sys.run, "chown", [`${app.user}:${app.user}`, target]);
        fs.chmodSync(target, 0o750);
      }
      fs.symlinkSync(path.join("..", "..", "shared", shared), inRelease);
    }
  } else {
    const root = manifest.root === "." ? dir : path.join(dir, manifest.root);
    if (!fs.existsSync(path.join(root, "index.html"))) {
      throw new DeployError(`tidak ada ${manifest.root}/index.html di paket`);
    }
  }
  return manifest;
}

/**
 * Versi runtime di server harus sama dengan deploy.json (Node: mayor; Python: mayor.minor, karena
 * wheel di vendor/ dibangun untuk satu versi Python).
 * @param {PlatformPaths} paths
 * @param {System} sys
 * @param {import("./manifest.js").ServiceManifest} manifest
 */
function checkRuntime(paths, sys, manifest) {
  const bin = runtimeBin(paths, manifest);
  const version = sys.run(bin, ["--version"]).stdout.trim();
  if (manifest.type === "python") {
    const minor = /^Python (\d+\.\d+)\./.exec(version)?.[1];
    if (minor !== manifest.python) {
      throw new DeployError(
        `deploy.json minta Python ${manifest.python}, server ${version ? `punya ${version} di ${bin}` : `tidak punya ${bin}`}`,
      );
    }
    return;
  }
  const major = /^v(\d+)\./.exec(version)?.[1];
  if (major !== manifest.node) {
    throw new DeployError(`deploy.json minta Node ${manifest.node}, server punya ${version || "(tidak ada)"}`);
  }
}

/**
 * Tunggu aplikasi menjawab health check, lalu pastikan masih hidup beberapa detik kemudian
 * (menangkap error yang datang belakangan, mis. 409 dari Telegram).
 * @param {DeployOptions & { app: AppPaths }} ctx
 * @param {import("./manifest.js").ServiceManifest} manifest
 */
async function waitHealthy(ctx, manifest) {
  const { sys, app } = ctx;
  const url = `http://127.0.0.1:${manifest.port}${manifest.health}`;
  const timeoutMs = ctx.healthTimeoutMs ?? 60_000;
  const deadline = sys.now().getTime() + timeoutMs;
  const ok = (/** @type {number} */ status) => status >= 200 && status < 400;
  const active = () => sys.run("systemctl", ["is-active", app.unit]).stdout.trim();
  // Restart otomatis oleh systemd = proses crash (systemd menahan state "activating" di antaranya).
  const restarts = () => Number(sys.run("systemctl", ["show", "-p", "NRestarts", "--value", app.unit]).stdout.trim()) || 0;

  while (sys.now().getTime() < deadline) {
    if (active() === "failed" || restarts() > 0) throw new DeployError(`${app.unit} crash saat start`);
    if (ok(await sys.httpStatus(url, 3_000))) {
      await sys.sleep(ctx.stableMs ?? 5_000);
      if (active() !== "active" || restarts() > 0) throw new DeployError(`${app.unit} berhenti setelah sempat sehat`);
      if (!ok(await sys.httpStatus(url, 3_000))) throw new DeployError(`${url} berhenti menjawab`);
      sys.log(`[deploy] sehat: ${url}`);
      return;
    }
    await sys.sleep(1_000);
  }
  throw new DeployError(`${url} tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik`);
}

/**
 * Tulis config Caddy app, validasi seluruh config, lalu reload Caddy tanpa downtime.
 * @param {DeployOptions & { app: AppPaths }} ctx
 * @param {Manifest} manifest
 */
function applyCaddy(ctx, manifest) {
  const { paths, sys, app } = ctx;
  writeOrRemove(app.site, renderCaddySite(manifest, app.current));
  must(sys.run, "caddy", ["validate", "--config", paths.caddyfile, "--adapter", "caddyfile"]);
  must(sys.run, "systemctl", ["reload", "caddy"]);
}

/**
 * Jadikan release aktif: symlink current, systemd (node/python), health check, Caddy.
 * @param {DeployOptions & { app: AppPaths }} ctx
 * @param {Manifest} manifest
 * @param {string} release
 */
async function activate(ctx, manifest, release) {
  const { paths, sys, app } = ctx;
  pointCurrent(app, release);
  if (isService(manifest)) {
    writeOrRemove(app.dropIn, renderSystemdDropIn(manifest, runtimeBin(paths, manifest)));
    must(sys.run, "systemctl", ["daemon-reload"]);
    must(sys.run, "systemctl", ["enable", "--quiet", app.unit]);
    sys.log(`[deploy] restart ${app.unit}`);
    // Batas start systemd (5x/5 menit) dari crash sebelumnya tidak boleh memblokir versi ini.
    sys.run("systemctl", ["reset-failed", app.unit]);
    must(sys.run, "systemctl", ["restart", app.unit]);
    await waitHealthy(ctx, manifest);
  } else {
    // Situs statis tidak punya service; kalau sebelumnya app node/python, matikan service-nya.
    if (fs.existsSync(app.dropIn)) {
      sys.run("systemctl", ["disable", "--now", "--quiet", app.unit]);
      writeOrRemove(app.dropIn, null);
      must(sys.run, "systemctl", ["daemon-reload"]);
    }
  }
  applyCaddy(ctx, manifest);
}

/**
 * @typedef {object} Snapshot
 * @property {string | null} release
 * @property {Manifest | null} manifest
 * @property {string | null} dropIn
 * @property {string | null} site
 */

/**
 * @param {AppPaths} app
 * @returns {Snapshot}
 */
function snapshot(app) {
  const release = currentRelease(app);
  return {
    release,
    manifest: release === null ? null : readManifestIn(path.join(app.releases, release)),
    dropIn: readOrNull(app.dropIn),
    site: readOrNull(app.site),
  };
}

/**
 * Kembalikan kondisi sebelum activate(). Error di sini hanya dicatat, supaya error aslinya
 * tetap yang dilaporkan.
 * @param {DeployOptions & { app: AppPaths }} ctx
 * @param {Snapshot} before
 */
async function restore(ctx, before) {
  const { sys, app, paths } = ctx;
  const attempt = (/** @type {string} */ label, /** @type {() => unknown} */ fn) => {
    try {
      fn();
    } catch (error) {
      sys.log(`[deploy] pemulihan (${label}) gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (isService(before.manifest) || fs.existsSync(app.dropIn)) {
    sys.log(`[deploy] log terakhir ${app.unit}:`);
    const logs = sys.run("journalctl", ["-u", app.unit, "-n", "40", "--no-pager", "-o", "cat"]);
    if (logs.stdout.trim()) sys.log(logs.stdout.trimEnd());
  }
  attempt("current", () => pointCurrent(app, before.release));
  attempt("systemd", () => {
    writeOrRemove(app.dropIn, before.dropIn);
    must(sys.run, "systemctl", ["daemon-reload"]);
    if (before.dropIn !== null && before.release !== null) {
      sys.run("systemctl", ["reset-failed", app.unit]);
      must(sys.run, "systemctl", ["restart", app.unit]);
    } else {
      sys.run("systemctl", ["disable", "--now", "--quiet", app.unit]);
    }
  });
  attempt("caddy", () => {
    writeOrRemove(app.site, before.site);
    must(sys.run, "caddy", ["validate", "--config", paths.caddyfile, "--adapter", "caddyfile"]);
    must(sys.run, "systemctl", ["reload", "caddy"]);
  });
  sys.log(before.release === null ? "[deploy] dikembalikan: app tidak aktif (deploy pertama gagal)" : `[deploy] dikembalikan ke release ${before.release}`);
}

/**
 * Hapus release lama; current, previous, dan KEEP_RELEASES terbaru tetap ada.
 * @param {AppPaths} app
 * @param {string[]} protect
 */
function pruneReleases(app, protect) {
  const releases = fs
    .readdirSync(app.releases)
    .filter((entry) => !entry.endsWith(".tmp"))
    .sort();
  const keep = new Set([...releases.slice(-KEEP_RELEASES), ...protect]);
  for (const entry of releases) {
    if (!keep.has(entry)) fs.rmSync(path.join(app.releases, entry), { recursive: true, force: true });
  }
}

/**
 * Deploy paket build untuk app terdaftar.
 * @param {DeployOptions & { name: string, sha: string, archive: string, repository?: string }} opts
 */
export async function deploy(opts) {
  const { paths, sys, name, sha, archive } = opts;
  if (!isRegistered(paths, name)) throw new DeployError(`app "${name}" belum terdaftar (sudo app register ${name})`);
  if (!SHA_RE.test(sha)) throw new DeployError("commit sha tidak valid");
  const app = appPaths(paths, name);
  const ctx = { ...opts, app };

  return withLock(app.lock, async () => {
    fs.mkdirSync(app.releases, { recursive: true });
    const release = releaseName(sys.now(), sha);
    const dir = path.join(app.releases, release);
    const tmp = `${dir}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    /** @type {Manifest} */
    let manifest;
    try {
      must(sys.run, "tar", ["-xzf", archive, "-C", tmp, "--no-same-owner", "--no-same-permissions"]);
      manifest = prepareRelease({ ...ctx, dir: tmp });
      must(sys.run, "chown", ["-R", "-h", "root:root", tmp]);
      fs.renameSync(tmp, dir);
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
    sys.log(`[deploy] ${name}: release ${release} (${manifest.type}, ${manifest.domains.join(", ")})`);

    const state = readState(app, name);
    const before = snapshot(app);
    const ref = { release, sha, at: sys.now().toISOString(), ...(opts.repository ? { repository: opts.repository } : {}) };
    try {
      await activate(ctx, manifest, release);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sys.log(`[deploy] GAGAL: ${message}`);
      await restore(ctx, before);
      fs.rmSync(dir, { recursive: true, force: true });
      writeState(app, { ...state, history: [...state.history, { ...ref, result: "failed", error: message.slice(0, 300) }] });
      throw error instanceof DeployError ? error : new DeployError(message);
    }

    writeState(app, {
      name,
      current: ref,
      previous: before.release === null ? state.previous : state.current,
      history: [...state.history, { ...ref, result: "ok" }],
    });
    const after = readState(app, name);
    pruneReleases(app, [release, after.previous?.release ?? ""].filter(Boolean));
    sys.log(`[deploy] ${name} ${sha.slice(0, 7)} aktif ✅`);
  });
}

/**
 * Restart app aktif lalu tunggu sehat (setelah env diubah). Situs statis: cukup reload Caddy.
 * @param {DeployOptions & { name: string }} opts
 */
export async function restartApp(opts) {
  const { paths, sys, name } = opts;
  if (!isRegistered(paths, name)) throw new DeployError(`app "${name}" belum terdaftar`);
  const app = appPaths(paths, name);
  const manifest = readActiveManifest(paths, name);
  if (manifest === null) throw new DeployError(`app "${name}" belum pernah di-deploy`);
  if (manifest.type === "static") {
    must(sys.run, "systemctl", ["reload", "caddy"]);
    return;
  }
  sys.run("systemctl", ["reset-failed", app.unit]);
  must(sys.run, "systemctl", ["restart", app.unit]);
  await waitHealthy({ ...opts, app }, manifest);
}

/**
 * Kembali ke release sebelumnya (state.previous).
 * @param {DeployOptions & { name: string }} opts
 */
export async function rollback(opts) {
  const { paths, sys, name } = opts;
  if (!isRegistered(paths, name)) throw new DeployError(`app "${name}" belum terdaftar`);
  const app = appPaths(paths, name);
  const ctx = { ...opts, app };
  return withLock(app.lock, async () => {
    const state = readState(app, name);
    const target = state.previous;
    if (target === null || !fs.existsSync(path.join(app.releases, target.release))) {
      throw new DeployError("tidak ada release sebelumnya untuk rollback");
    }
    const manifest = readManifestIn(path.join(app.releases, target.release));
    if (manifest === null) throw new DeployError(`deploy.json release ${target.release} rusak`);
    const before = snapshot(app);
    try {
      await activate(ctx, manifest, target.release);
    } catch (error) {
      await restore(ctx, before);
      throw error instanceof DeployError ? error : new DeployError(String(error));
    }
    const ref = { ...target, at: sys.now().toISOString() };
    writeState(app, {
      name,
      current: ref,
      previous: state.current,
      history: [...state.history, { ...ref, result: "rollback" }],
    });
    sys.log(`[rollback] ${name} kembali ke ${target.release} ✅`);
  });
}
