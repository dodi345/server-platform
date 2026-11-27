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
/** Versi Python mayor.minor, mis. "3.12" (wheel hasil build hanya cocok untuk versi yang sama). */
const PYTHON_VERSION_RE = /^3\.\d{1,2}$/;

const COMMON_KEYS = ["name", "type", "domains", "redirect_www", "build", "node", "package"];
/** Field app yang jalan sebagai service (node, python). */
const SERVICE_KEYS = ["port", "start", "health", "shared", "memory", "required_env", "backup"];
const STATIC_KEYS = [
  "root",
  "spa",
  "clean_urls",
  "not_found",
  "headers",
  "file_headers",
  "immutable",
  "redirects",
];

/** Path persis di URL (tanpa wildcard). */
const URL_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
/** Pola path: path persis, atau diakhiri "*" (awalan). */
const URL_PATTERN_RE = /^\/[A-Za-z0-9._~/-]*\*?$/;
/** Awalan path untuk 404 per bagian situs: diawali dan diakhiri "/". */
const URL_PREFIX_RE = /^\/(?:[A-Za-z0-9._~-]+\/)*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Nilai header: ASCII tampak + spasi, tanpa " \ ` { } (bisa memecah atau mengubah config Caddy). */
const HEADER_VALUE_RE = /^[\x20-\x21\x23-\x5B\x5D-\x5F\x61-\x7A\x7C\x7E]{1,2000}$/;
const SIMPLE_TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REDIRECT_STATUSES = [301, 302, 307, 308];
/** Header yang diatur platform sendiri (lihat "immutable"). */
const MANAGED_HEADERS = ["cache-control"];

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
 * @property {string[]} backup file/folder di folder shared yang ikut backup off-site (mis. "data/app.db")
 */

/**
 * App Python (v1.6): dependency dipasang di GitHub ke folder `vendor/` (pip install --target), lalu
 * dijalankan dengan /usr/bin/python<versi> dan PYTHONPATH=vendor.
 * @typedef {object} PythonManifest
 * @property {string} name
 * @property {"python"} type
 * @property {string[]} domains
 * @property {boolean} redirect_www
 * @property {string | null} build
 * @property {string} python versi mayor.minor, mis. "3.12"
 * @property {string | null} node Node opsional untuk langkah build (mis. aset frontend)
 * @property {string[]} package
 * @property {number} port
 * @property {string[]} start ["python", "-m", "<modul>", ...] atau ["python", "<file>.py", ...]
 * @property {string} health
 * @property {string[]} shared
 * @property {string} memory
 * @property {string[]} required_env
 * @property {string[]} backup
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
 * @property {boolean} clean_urls
 * @property {{ prefix: string, file: string }[]} not_found urut dari awalan terpanjang
 * @property {Record<string, string>} headers
 * @property {Record<string, Record<string, string>>} file_headers
 * @property {string[]} immutable
 * @property {Redirect[]} redirects
 */

/**
 * @typedef {object} Redirect
 * @property {string} from
 * @property {string} to
 * @property {number} status
 * @property {{ cookie: { name: string, value: string } } | { header: { name: string, prefix: string } } | null} when
 */

/** @typedef {NodeManifest | PythonManifest} ServiceManifest */
/** @typedef {NodeManifest | PythonManifest | StaticManifest} Manifest */

/**
 * App yang jalan sebagai service systemd (punya port, health check, env, backup).
 * @param {Manifest | null | undefined} manifest
 * @returns {manifest is ServiceManifest}
 */
export function isService(manifest) {
  return manifest?.type === "node" || manifest?.type === "python";
}

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
  if (type !== "node" && type !== "python" && type !== "static") {
    problems.push('type: harus "node", "python", atau "static"');
  }
  const service = type === "node" || type === "python";
  const allowed = [...COMMON_KEYS, ...(service ? SERVICE_KEYS : STATIC_KEYS), ...(type === "python" ? ["python"] : [])];
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

  const pythonVersion = raw.python ?? null;
  if (type === "python" && (typeof pythonVersion !== "string" || !PYTHON_VERSION_RE.test(pythonVersion))) {
    problems.push('python: versi Python di server, mis. "3.12" (Ubuntu 24.04)');
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

  if (service) {
    const port = raw.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
      problems.push("port: bilangan bulat 1024–65535");
    }
    const start = raw.start;
    if (!Array.isArray(start) || start.length < 2 || start[0] !== type) {
      problems.push(
        type === "python"
          ? 'start: ["python", "-m", "<modul>", ...argumen] atau ["python", "<file>.py", ...argumen]'
          : 'start: ["node", "<file>", ...argumen]',
      );
    } else if (type === "python" && start[1] === "-m" && start.length < 3) {
      problems.push('start: nama modul setelah "-m", mis. ["python", "-m", "gunicorn", ...]');
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
    const backupPaths = raw.backup ?? [];
    const sharedDirs = Array.isArray(raw.shared) ? raw.shared : [];
    if (!Array.isArray(backupPaths) || backupPaths.length > 20) problems.push("backup: daftar maks 20 path");
    else {
      backupPaths.forEach((p, i) => {
        if (typeof p !== "string" || !REL_PATH_RE.test(p) || p.endsWith("/")) {
          problems.push(`backup[${i}]: path relatif, mis. "data/app.db"`);
        } else if (!sharedDirs.some((s) => typeof s === "string" && (p === s || p.startsWith(`${s}/`)))) {
          problems.push(`backup[${i}]: harus di dalam folder shared (${sharedDirs.join(", ") || "belum ada"})`);
        }
      });
      if (new Set(backupPaths).size !== backupPaths.length) problems.push("backup: ada path ganda");
    }
  } else if (type === "static") {
    const root = raw.root ?? ".";
    if (typeof root !== "string" || (root !== "." && !REL_PATH_RE.test(root))) {
      problems.push('root: folder relatif berisi file situs, mis. "dist"');
    }
    for (const key of ["spa", "clean_urls"]) {
      if (typeof (raw[key] ?? false) !== "boolean") problems.push(`${key}: true/false`);
    }
    if (raw.spa === true && raw.clean_urls === true) problems.push("spa dan clean_urls tidak bisa dipakai bersamaan");
    parseNotFound(raw.not_found ?? null, problems);
    checkHeaders("headers", raw.headers ?? {}, problems);
    const fileHeaders = raw.file_headers ?? {};
    if (!isObject(fileHeaders) || Object.keys(fileHeaders).length > 20) {
      problems.push("file_headers: objek path → header, maks 20 path");
    } else {
      for (const [p, headers] of Object.entries(fileHeaders)) {
        if (!URL_PATH_RE.test(p)) problems.push(`file_headers["${p}"]: path persis, diawali "/"`);
        checkHeaders(`file_headers["${p}"]`, headers, problems);
      }
    }
    const immutable = raw.immutable ?? [];
    if (!Array.isArray(immutable) || immutable.length > 10) problems.push("immutable: daftar maks 10 pola path");
    else {
      immutable.forEach((p, i) => {
        if (typeof p !== "string" || !URL_PATTERN_RE.test(p)) problems.push(`immutable[${i}]: pola path, mis. "/_astro/*"`);
      });
    }
    parseRedirects(raw.redirects ?? [], problems);
  }

  if (problems.length > 0) throw new ManifestError(problems);

  const common = {
    name: /** @type {string} */ (name),
    domains,
    redirect_www: /** @type {boolean} */ (redirectWww),
    build: /** @type {string | null} */ (build),
    package: pkg,
  };
  if (service) {
    const fields = {
      ...common,
      port: /** @type {number} */ (raw.port),
      start: /** @type {string[]} */ (raw.start),
      health: /** @type {string} */ (raw.health ?? "/"),
      shared: /** @type {string[]} */ (raw.shared ?? []),
      memory: /** @type {string} */ (raw.memory ?? "300M"),
      required_env: /** @type {string[]} */ (raw.required_env ?? []),
      backup: /** @type {string[]} */ (raw.backup ?? []),
    };
    if (type === "python") {
      return {
        ...fields,
        type: "python",
        python: /** @type {string} */ (pythonVersion),
        node: /** @type {string | null} */ (nodeVersion),
      };
    }
    return { ...fields, type: "node", node: /** @type {string} */ (nodeVersion) };
  }
  return {
    ...common,
    type: "static",
    node: /** @type {string | null} */ (nodeVersion),
    root: /** @type {string} */ (raw.root ?? "."),
    spa: /** @type {boolean} */ (raw.spa ?? false),
    clean_urls: /** @type {boolean} */ (raw.clean_urls ?? false),
    not_found: parseNotFound(raw.not_found ?? null, []),
    headers: /** @type {Record<string, string>} */ (raw.headers ?? {}),
    file_headers: /** @type {Record<string, Record<string, string>>} */ (raw.file_headers ?? {}),
    immutable: /** @type {string[]} */ (raw.immutable ?? []),
    redirects: parseRedirects(raw.redirects ?? [], []),
  };
}

/**
 * not_found: "404.html" (semua path) atau { "/id/": "id/404.html", "/": "404.html" }.
 * @param {unknown} value
 * @param {string[]} problems
 * @returns {{ prefix: string, file: string }[]}
 */
function parseNotFound(value, problems) {
  if (value === null) return [];
  /** @type {[string, unknown][]} */
  const entries = typeof value === "string" ? [["/", value]] : isObject(value) ? Object.entries(/** @type {object} */ (value)) : [];
  if (entries.length === 0 || entries.length > 10) {
    problems.push('not_found: "404.html" atau objek awalan → file, mis. {"/id/": "id/404.html", "/": "404.html"}');
    return [];
  }
  /** @type {{ prefix: string, file: string }[]} */
  const result = [];
  for (const [prefix, file] of entries) {
    if (!URL_PREFIX_RE.test(prefix)) problems.push(`not_found["${prefix}"]: awalan diawali dan diakhiri "/"`);
    else if (typeof file !== "string" || !REL_PATH_RE.test(file)) problems.push(`not_found["${prefix}"]: file relatif terhadap root`);
    else result.push({ prefix, file });
  }
  return result.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * @param {string} field
 * @param {unknown} headers
 * @param {string[]} problems
 */
function checkHeaders(field, headers, problems) {
  if (!isObject(headers) || Object.keys(/** @type {object} */ (headers)).length > 30) {
    problems.push(`${field}: objek nama → nilai header, maks 30`);
    return;
  }
  for (const [name, value] of Object.entries(/** @type {object} */ (headers))) {
    if (!HEADER_NAME_RE.test(name)) problems.push(`${field}: nama header "${name}" tidak valid`);
    else if (MANAGED_HEADERS.includes(name.toLowerCase())) problems.push(`${field}: ${name} diatur platform (pakai "immutable")`);
    else if (typeof value !== "string" || !HEADER_VALUE_RE.test(value)) {
      problems.push(`${field}: nilai ${name} harus teks satu baris tanpa " \\ \` { }`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string[]} problems
 * @returns {Redirect[]}
 */
function parseRedirects(value, problems) {
  if (!Array.isArray(value) || value.length > 30) {
    problems.push("redirects: daftar maks 30 aturan");
    return [];
  }
  /** @type {Redirect[]} */
  const result = [];
  value.forEach((rule, i) => {
    const field = `redirects[${i}]`;
    if (!isObject(rule)) {
      problems.push(`${field}: objek { from, to, status }`);
      return;
    }
    const r = /** @type {Record<string, unknown>} */ (rule);
    for (const key of Object.keys(r)) {
      if (!["from", "to", "status", "when"].includes(key)) problems.push(`${field}.${key}: field tidak dikenal`);
    }
    const from = r.from;
    const to = r.to;
    const status = r.status ?? 301;
    let ok = true;
    if (typeof from !== "string" || !URL_PATH_RE.test(from)) {
      problems.push(`${field}.from: path persis, diawali "/"`);
      ok = false;
    }
    const toUrl = typeof to === "string" && /^https:\/\/([^/]+)(\/.*)?$/.exec(to);
    const toValid =
      typeof to === "string" &&
      (URL_PATH_RE.test(to) || (toUrl !== false && toUrl !== null && DOMAIN_RE.test(toUrl[1] ?? "") && URL_PATH_RE.test(toUrl[2] ?? "/")));
    if (!toValid) {
      problems.push(`${field}.to: path "/..." atau URL https://domain/...`);
      ok = false;
    }
    if (typeof status !== "number" || !REDIRECT_STATUSES.includes(status)) {
      problems.push(`${field}.status: ${REDIRECT_STATUSES.join(", ")}`);
      ok = false;
    }
    /** @type {Redirect["when"]} */
    let when = null;
    if (r.when !== undefined) {
      const w = r.when;
      const keys = isObject(w) ? Object.keys(/** @type {object} */ (w)) : [];
      const cookie = isObject(w) ? /** @type {Record<string, unknown>} */ (w).cookie : undefined;
      const header = isObject(w) ? /** @type {Record<string, unknown>} */ (w).header : undefined;
      const prefix = isObject(w) ? /** @type {Record<string, unknown>} */ (w).prefix : undefined;
      const cookieMatch = typeof cookie === "string" ? /^([A-Za-z0-9._-]{1,64})=([A-Za-z0-9._-]{1,64})$/.exec(cookie) : null;
      if (cookieMatch && keys.length === 1) {
        when = { cookie: { name: /** @type {string} */ (cookieMatch[1]), value: /** @type {string} */ (cookieMatch[2]) } };
      } else if (
        typeof header === "string" &&
        HEADER_NAME_RE.test(header) &&
        typeof prefix === "string" &&
        SIMPLE_TOKEN_RE.test(prefix) &&
        keys.length === 2
      ) {
        when = { header: { name: header, prefix } };
      } else {
        problems.push(`${field}.when: { "cookie": "nama=nilai" } atau { "header": "Nama", "prefix": "nilai" }`);
        ok = false;
      }
    }
    if (ok) result.push({ from: /** @type {string} */ (from), to: /** @type {string} */ (to), status, when });
  });
  return result;
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
    if (isService(manifest) && isService(other) && other.port === manifest.port) {
      problems.push(`port ${manifest.port} sudah dipakai app "${other.name}"`);
    }
  }
  return problems;
}
