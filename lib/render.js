// @ts-check
// Config Caddy dan drop-in systemd dari manifest yang sudah divalidasi (lib/manifest.js).

import { isService } from "./manifest.js";

/** @typedef {import("./manifest.js").Manifest} Manifest */

const HEADER = (/** @type {string} */ name) =>
  `# server-platform: dibuat otomatis dari deploy.json app "${name}". Jangan diedit manual.\n`;

/**
 * @param {Manifest} manifest
 * @param {string} currentDir path absolut ke /srv/apps/<name>/current
 * @returns {string}
 */
export function renderCaddySite(manifest, currentDir) {
  const redirects = manifest.redirect_www ? manifest.domains.filter((d) => d.startsWith("www.")) : [];
  const primary = manifest.domains.filter((d) => !redirects.includes(d));
  const lines = [HEADER(manifest.name).trimEnd(), `${primary.join(", ")} {`, "\tencode zstd gzip", "\theader -Server"];

  if (isService(manifest)) {
    // X-Real-IP = IP asli pengunjung versi Caddy ({client_ip}, lihat trusted_proxies di Caddyfile utama),
    // selalu ditimpa sehingga tidak bisa dipalsukan pengunjung.
    lines.push(`\treverse_proxy 127.0.0.1:${manifest.port} {`, "\t\theader_up X-Real-IP {client_ip}", "\t}");
  } else {
    lines.push(...renderStaticBody(manifest, currentDir));
  }
  lines.push("}");

  for (const www of redirects) {
    lines.push("", `${www} {`, `\tredir https://${www.slice(4)}{uri} permanent`, "}");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Isi blok situs statis. Semua langkah dibungkus `route` supaya urutannya persis seperti
 * tertulis (Caddy biasanya mengurutkan directive sendiri). Nilai sudah divalidasi manifest.js.
 * @param {import("./manifest.js").StaticManifest} m
 * @param {string} currentDir
 * @returns {string[]}
 */
function renderStaticBody(m, currentDir) {
  const root = m.root === "." ? currentDir : `${currentDir}/${m.root}`;
  /** @type {string[]} */
  const matchers = [];
  /** @type {string[]} */
  const route = [];
  const headerBlock = (/** @type {string} */ indent) =>
    Object.keys(m.headers).length === 0
      ? []
      : [`${indent}header {`, ...Object.entries(m.headers).map(([k, v]) => `${indent}\t${k} "${v}"`), `${indent}}`];

  route.push(...headerBlock("\t\t"));

  // Cache: aset ber-hash disimpan setahun; selain itu selalu dicek ulang (304 kalau tidak berubah),
  // supaya pengunjung langsung mendapat versi baru setelah deploy.
  if (m.immutable.length > 0) {
    matchers.push(`\t@immutable path ${m.immutable.join(" ")}`, `\t@revalidate not path ${m.immutable.join(" ")}`);
    route.push('\t\theader @immutable Cache-Control "public, max-age=31536000, immutable"');
    route.push('\t\theader @revalidate Cache-Control "no-cache"');
  } else {
    route.push('\t\theader Cache-Control "no-cache"');
  }

  Object.entries(m.file_headers).forEach(([path, headers], i) => {
    matchers.push(`\t@file${i} path ${path}`);
    // ">" = ditulis saat respons dikirim, jadi menimpa header dari file_server (mis. Content-Type).
    for (const [k, v] of Object.entries(headers)) route.push(`\t\theader @file${i} >${k} "${v}"`);
  });

  m.redirects.forEach((r, i) => {
    const conditions = [`path ${r.from}`];
    if (r.when !== null && "cookie" in r.when) {
      conditions.push(`expression \`{http.request.cookie.${r.when.cookie.name}} == "${r.when.cookie.value}"\``);
    } else if (r.when !== null && "header" in r.when) {
      conditions.push(`header ${r.when.header.name} ${r.when.header.prefix}*`);
    }
    matchers.push(`\t@redirect${i} {`, ...conditions.map((c) => `\t\t${c}`), "\t}");
    route.push(`\t\tredir @redirect${i} ${r.to} ${r.status}`);
  });

  route.push(`\t\troot * ${root}`);
  if (m.spa) route.push("\t\ttry_files {path} /index.html");
  else if (m.clean_urls) route.push("\t\ttry_files {path} {path}.html {path}/index.html");
  route.push("\t\tfile_server");

  const lines = [...matchers, "\troute {", ...route, "\t}"];

  if (m.not_found.length > 0) {
    // Satu matcher per awalan, saling lepas (awalan yang lebih panjang dikecualikan dari yang pendek).
    lines.push("\thandle_errors {");
    m.not_found.forEach((entry, i) => {
      const longer = m.not_found.slice(0, i).map((e) => `${e.prefix}*`);
      lines.push(
        `\t\t@notfound${i} {`,
        "\t\t\texpression `{err.status_code} == 404`",
        `\t\t\tpath ${entry.prefix}*`,
        ...(longer.length > 0 ? [`\t\t\tnot path ${longer.join(" ")}`] : []),
        "\t\t}",
        `\t\thandle @notfound${i} {`,
        ...headerBlock("\t\t\t"),
        '\t\t\theader Cache-Control "no-cache"',
        `\t\t\troot * ${root}`,
        `\t\t\trewrite * /${entry.file}`,
        "\t\t\tfile_server",
        "\t\t}",
      );
    });
    lines.push("\t}");
  }
  return lines;
}

/**
 * Drop-in untuk template app@.service: perintah start dan batas memori dari manifest.
 * App Python: dependency dari folder vendor/ di release (PYTHONPATH relatif terhadap WorkingDirectory,
 * dijadikan absolut oleh Python saat start, jadi proses tetap memakai release-nya sendiri), log langsung
 * ke journald, tanpa menulis .pyc (folder release read-only), dan MALLOC_ARENA_MAX=2: server Python
 * ber-thread (gunicorn --threads) tidak menimbun memori per thread (diukur: puncak 440 → 365 MB untuk
 * 3 gambar 12 MP). Nilai di shared/.env menimpa Environment= ini.
 * @param {import("./manifest.js").ServiceManifest} manifest
 * @param {string} bin path absolut runtime, mis. /usr/bin/node atau /usr/bin/python3.12
 * @returns {string}
 */
export function renderSystemdDropIn(manifest, bin) {
  const args = manifest.start.slice(1).join(" ");
  const env =
    manifest.type === "python"
      ? "Environment=PYTHONPATH=vendor PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MALLOC_ARENA_MAX=2\n"
      : "";
  return `${HEADER(manifest.name)}[Service]\nExecStart=${bin} ${args}\n${env}MemoryMax=${manifest.memory}\n`;
}

/**
 * Path runtime app service di server.
 * @param {{ nodeBin: string, pythonPrefix: string }} paths
 * @param {import("./manifest.js").ServiceManifest} manifest
 */
export function runtimeBin(paths, manifest) {
  return manifest.type === "python" ? `${paths.pythonPrefix}${manifest.python}` : paths.nodeBin;
}
