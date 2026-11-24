// @ts-check
// Config Caddy dan drop-in systemd dari manifest yang sudah divalidasi (lib/manifest.js).

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

  if (manifest.type === "node") {
    lines.push(`\treverse_proxy 127.0.0.1:${manifest.port}`);
  } else {
    const root = manifest.root === "." ? currentDir : `${currentDir}/${manifest.root}`;
    lines.push(`\troot * ${root}`);
    if (manifest.spa) lines.push("\ttry_files {path} /index.html");
    lines.push("\tfile_server");
    if (manifest.not_found !== null) {
      lines.push(
        "\thandle_errors {",
        "\t\t@notfound expression {err.status_code} == 404",
        "\t\thandle @notfound {",
        `\t\t\trewrite * /${manifest.not_found}`,
        "\t\t\tfile_server",
        "\t\t}",
        "\t}",
      );
    }
  }
  lines.push("}");

  for (const www of redirects) {
    lines.push("", `${www} {`, `\tredir https://${www.slice(4)}{uri} permanent`, "}");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Drop-in untuk template app@.service: perintah start dan batas memori dari manifest.
 * @param {import("./manifest.js").NodeManifest} manifest
 * @param {string} nodeBin path absolut node, mis. /usr/bin/node
 * @returns {string}
 */
export function renderSystemdDropIn(manifest, nodeBin) {
  const args = manifest.start.slice(1).join(" ");
  return `${HEADER(manifest.name)}[Service]\nExecStart=${nodeBin} ${args}\nMemoryMax=${manifest.memory}\n`;
}
