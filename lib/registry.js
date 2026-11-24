// @ts-check
// Daftar app di /srv/apps: lokasi file per app, manifest aktif, dan state deploy.
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, parseManifest } from "./manifest.js";

/** @typedef {import("./system.js").PlatformPaths} PlatformPaths */
/** @typedef {import("./manifest.js").Manifest} Manifest */

/**
 * @typedef {object} ReleaseRef
 * @property {string} release nama folder di releases/
 * @property {string} sha
 * @property {string} at waktu ISO UTC
 */

/**
 * @typedef {object} AppState
 * @property {string} name
 * @property {ReleaseRef | null} current
 * @property {ReleaseRef | null} previous
 * @property {(ReleaseRef & { result: "ok" | "failed" | "rollback", error?: string })[]} history
 */

/**
 * @param {PlatformPaths} paths
 * @param {string} name
 */
export function appPaths(paths, name) {
  const dir = path.join(paths.apps, name);
  const dropInDir = path.join(paths.systemdDir, `app@${name}.service.d`);
  return {
    dir,
    registration: path.join(dir, "app.json"),
    releases: path.join(dir, "releases"),
    current: path.join(dir, "current"),
    shared: path.join(dir, "shared"),
    env: path.join(dir, "shared", ".env"),
    state: path.join(dir, "state.json"),
    lock: path.join(dir, ".deploy.lock"),
    site: path.join(paths.caddySites, `${name}.caddy`),
    dropInDir,
    dropIn: path.join(dropInDir, "10-deploy.conf"),
    unit: `app@${name}.service`,
    user: `app-${name}`,
  };
}

/** @typedef {ReturnType<typeof appPaths>} AppPaths */

/**
 * @param {PlatformPaths} paths
 * @param {string} name
 */
export function isRegistered(paths, name) {
  return NAME_RE.test(name) && fs.existsSync(appPaths(paths, name).registration);
}

/** @param {PlatformPaths} paths */
export function listAppNames(paths) {
  if (!fs.existsSync(paths.apps)) return [];
  return fs
    .readdirSync(paths.apps)
    .filter((name) => isRegistered(paths, name))
    .sort();
}

/**
 * Manifest release yang sedang aktif; null kalau belum pernah deploy atau rusak.
 * @param {PlatformPaths} paths
 * @param {string} name
 * @returns {Manifest | null}
 */
export function readActiveManifest(paths, name) {
  return readManifestIn(path.join(appPaths(paths, name).current));
}

/**
 * @param {string} releaseDir
 * @returns {Manifest | null}
 */
export function readManifestIn(releaseDir) {
  try {
    return parseManifest(JSON.parse(fs.readFileSync(path.join(releaseDir, "deploy.json"), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Release yang ditunjuk symlink current (nama folder), atau null.
 * @param {AppPaths} app
 */
export function currentRelease(app) {
  try {
    return path.basename(fs.readlinkSync(app.current));
  } catch {
    return null;
  }
}

/**
 * @param {AppPaths} app
 * @param {string} name
 * @returns {AppState}
 */
export function readState(app, name) {
  try {
    const state = JSON.parse(fs.readFileSync(app.state, "utf8"));
    return { name, current: state.current ?? null, previous: state.previous ?? null, history: state.history ?? [] };
  } catch {
    return { name, current: null, previous: null, history: [] };
  }
}

/**
 * @param {AppPaths} app
 * @param {AppState} state
 */
export function writeState(app, state) {
  const tmp = `${app.state}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...state, history: state.history.slice(-20) }, null, 2)}\n`);
  fs.renameSync(tmp, app.state);
}
