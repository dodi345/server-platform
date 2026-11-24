// @ts-check
// Validasi deploy.json. Semua nilai yang nanti ditulis ke config Caddy atau systemd dibatasi
// ketat di sini (tanpa spasi, kutip, kurung kurawal, dll.), supaya manifest tidak bisa
// menyisipkan config lain.

export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const LABEL = "(?!-)[a-z0-9-]{1,63}(?<!-)";
export const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+[a-z]{2,63}$`);
/** Argumen perintah start: tanpa spasi, kutip, $, %, atau karakter shell. */
const ARG_RE = /^[A-Za-z0-9._/:=@+,-]+$/;
/** Path relatif di dalam release: tanpa / di depan dan tanpa segmen "..". */
const REL_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+-]+$/;
const SHARED_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const MEMORY_RE = /^(?:[1-9]\d{1,4}M|[1-9](?:\.\d)?G)$/;
const HEALTH_RE = /^\/[A-Za-z0-9._/~-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_MAJOR_RE = /^\d{2}$/;

const COMMON_KEYS = ["name", "type", "domains", "redirect_www", "build", "node", "package"];
const NODE_KEYS = ["port", "start", "health", "shared", "memory", "required_env"];
const STATIC_KEYS = ["root", "spa", "not_found"];

/**
 * @typedef {object} NodeManifest
 * @property {string} name
 * @property {"node"} type
 * @property {string[]} domains
 * @property {boolean} redirect_www
 * @property {string | null} build
 * @property {string} node
 * @property {string[]} package
 * @property {number} port
 * @property {string[]} start
 * @property {string} health
 * @property {string[]} shared
 * @property {string} memory
 * @property {string[]} required_env
 */

/**
 * @typedef {object} StaticManifest
 * @property {string} name
 * @property {"static"} type
 * @property {string[]} domains
 * @property {boolean} redirect_www
 * @property {string | null} build
 * @property {string | null} node
 * @property {string[]} package
 * @property {string} root
 * @property {boolean} spa
 * @property {string | null} not_found
 */

/** @typedef {NodeManifest | StaticManifest} Manifest */

export class ManifestError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`deploy.json tidak valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

/** @param {unknown} value */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Manifest}
 */
export function parseManifest(value) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(value)) throw new ManifestError(["isi harus objek JSON"]);
  const raw = /** @type {Record<string, unknown>} */ (value);

  const type = raw.type;
  if (type !== "node" && type !== "static") problems.push('type: harus "node" atau "static"');
  const allowed = [...COMMON_KEYS, ...(type === "node" ? NODE_KEYS : STATIC_KEYS)];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) problems.push(`${key}: field tidak dikenal untuk type ${String(type)}`);
  }

  const name = raw.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    problems.push("name: huruf kecil/angka/'-', diawali huruf, 2–31 karakter");
  }

  /** @type {string[]} */
  let domains = [];
  if (!Array.isArray(raw.domains) || raw.domains.length === 0 || raw.domains.length > 10) {
    problems.push("domains: daftar 1–10 domain");
  } else {
    domains = raw.domains.map((d) => (typeof d === "string" ? d.trim().toLowerCase() : ""));
    domains.forEach((d, i) => {
      if (!DOMAIN_RE.test(d)) problems.push(`domains[${i}]: bukan nama domain yang valid`);
    });
    if (new Set(domains).size !== domains.length) problems.push("domains: ada domain ganda");
  }

  const redirectWww = raw.redirect_www ?? false;
  if (typeof redirectWww !== "boolean") problems.push("redirect_www: true/false");
  if (redirectWww === true) {
    const www = domains.filter((d) => d.startsWith("www."));
    if (www.length === 0) problems.push("redirect_www: tidak ada domain www.* di domains");
    for (const d of www) {
      if (!domains.includes(d.slice(4))) {
        problems.push(`redirect_www: ${d} butuh ${d.slice(4)} juga di domains`);
      }
    }
    if (domains.every((d) => d.startsWith("www."))) {
      problems.push("redirect_www: harus ada domain utama selain www.*");
    }
  }

  const build = raw.build ?? null;
  if (build !== null && (typeof build !== "string" || build.trim() === "" || build.length > 500)) {
    problems.push("build: perintah build (string, maks 500 karakter)");
  }

  const nodeVersion = raw.node ?? null;
  if (type === "node" && (typeof nodeVersion !== "string" || !NODE_MAJOR_RE.test(nodeVersion))) {
    problems.push('node: versi mayor Node, mis. "24"');
  } else if (nodeVersion !== null && (typeof nodeVersion !== "string" || !NODE_MAJOR_RE.test(nodeVersion))) {
    problems.push('node: versi mayor Node, mis. "24"');
  }

  /** @type {string[]} */
  let pkg = [];
  if (!Array.isArray(raw.package) || raw.package.length === 0 || raw.package.length > 30) {
    problems.push("package: daftar 1–30 path yang ikut paket");
  } else {
    pkg = raw.package.map((p) => (typeof p === "string" ? p.replace(/\/+$/, "") : ""));
    pkg.forEach((p, i) => {
      if (!REL_PATH_RE.test(p)) problems.push(`package[${i}]: path relatif tanpa ".."`);
    });
  }

  if (type === "node") {
    const port = raw.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
      problems.push("port: bilangan bulat 1024–65535");
    }
    const start = raw.start;
    if (!Array.isArray(start) || start.length < 2 || start[0] !== "node") {
      problems.push('start: ["node", "<file>", ...argumen]');
    } else {
      start.forEach((arg, i) => {
        if (typeof arg !== "string" || !ARG_RE.test(arg)) {
          problems.push(`start[${i}]: tanpa spasi/kutip/karakter khusus`);
        }
      });
    }
    const health = raw.health ?? "/";
    if (typeof health !== "string" || !HEALTH_RE.test(health)) {
      problems.push('health: path diawali "/", mis. "/api/health"');
    }
    const shared = raw.shared ?? [];
    if (!Array.isArray(shared) || shared.length > 10) problems.push("shared: daftar maks 10 folder");
    else {
      shared.forEach((s, i) => {
        if (typeof s !== "string" || !SHARED_RE.test(s)) problems.push(`shared[${i}]: nama folder sederhana, mis. "data"`);
      });
      if (new Set(shared).size !== shared.length) problems.push("shared: ada folder ganda");
      for (const s of shared) {
        if (pkg.some((p) => p === s || p.startsWith(`${s}/`))) {
          problems.push(`shared: "${s}" juga ada di package (data tidak boleh ikut paket)`);
        }
      }
    }
    const memory = raw.memory ?? "300M";
    if (typeof memory !== "string" || !MEMORY_RE.test(memory)) {
      problems.push('memory: mis. "300M" atau "1G"');
    }
    const requiredEnv = raw.required_env ?? [];
    if (!Array.isArray(requiredEnv) || requiredEnv.some((k) => typeof k !== "string" || !ENV_KEY_RE.test(k))) {
      problems.push("required_env: daftar nama variabel env");
    }
  } else if (type === "static") {
    const root = raw.root ?? ".";
    if (typeof root !== "string" || (root !== "." && !REL_PATH_RE.test(root))) {
      problems.push('root: folder relatif berisi file situs, mis. "dist"');
    }
    const spa = raw.spa ?? false;
    if (typeof spa !== "boolean") problems.push("spa: true/false");
    const notFound = raw.not_found ?? null;
    if (notFound !== null && (typeof notFound !== "string" || !REL_PATH_RE.test(notFound))) {
      problems.push('not_found: file relatif terhadap root, mis. "404.html"');
    }
  }

  if (problems.length > 0) throw new ManifestError(problems);

  const common = {
    name: /** @type {string} */ (name),
    domains,
    redirect_www: /** @type {boolean} */ (redirectWww),
    build: /** @type {string | null} */ (build),
    package: pkg,
  };
  if (type === "node") {
    return {
      ...common,
      type: "node",
      node: /** @type {string} */ (nodeVersion),
      port: /** @type {number} */ (raw.port),
      start: /** @type {string[]} */ (raw.start),
      health: /** @type {string} */ (raw.health ?? "/"),
      shared: /** @type {string[]} */ (raw.shared ?? []),
      memory: /** @type {string} */ (raw.memory ?? "300M"),
      required_env: /** @type {string[]} */ (raw.required_env ?? []),
    };
  }
  return {
    ...common,
    type: "static",
    node: /** @type {string | null} */ (nodeVersion),
    root: /** @type {string} */ (raw.root ?? "."),
    spa: /** @type {boolean} */ (raw.spa ?? false),
    not_found: /** @type {string | null} */ (raw.not_found ?? null),
  };
}

/**
 * Bentrok dengan app lain: domain atau port yang sama.
 * @param {Manifest} manifest
 * @param {Manifest[]} others manifest aktif app lain
 * @returns {string[]}
 */
export function conflicts(manifest, others) {
  /** @type {string[]} */
  const problems = [];
  for (const other of others) {
    if (other.name === manifest.name) continue;
    for (const d of manifest.domains) {
      if (other.domains.includes(d)) problems.push(`domain ${d} sudah dipakai app "${other.name}"`);
    }
    if (manifest.type === "node" && other.type === "node" && other.port === manifest.port) {
      problems.push(`port ${manifest.port} sudah dipakai app "${other.name}"`);
    }
  }
  return problems;
}
