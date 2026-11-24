// @ts-check
// Situs statis hasil render benar-benar disajikan Caddy (image Docker resmi), lalu dicek lewat
// HTTP: status, header, redirect bersyarat, clean URL, 404 per awalan. Dilewati tanpa Docker.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { renderCaddySite } from "../lib/render.js";
import { realRun } from "../lib/system.js";

const hasDocker = realRun("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;
const BASE_CADDYFILE = fileURLToPath(new URL("../caddy/Caddyfile", import.meta.url));

const FILES = {
  "index.html": "root-index",
  "en/index.html": "en-index",
  "id/index.html": "id-index",
  "card.html": "card-page",
  "404.html": "not-found-en",
  "id/404.html": "not-found-id",
  "_astro/app.abc123.js": "console.log(1)",
  "kartu.vcf": "BEGIN:VCARD",
  "cv-en.pdf": "%PDF",
};

const MANIFEST = {
  name: "situs",
  type: "static",
  domains: ["situs.localhost", "www.situs.localhost"],
  redirect_www: true,
  package: ["dist"],
  root: "dist",
  clean_urls: true,
  headers: {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:",
  },
  file_headers: { "/kartu.vcf": { "Content-Type": "text/vcard; charset=utf-8" } },
  immutable: ["/_astro/*"],
  not_found: { "/": "404.html", "/id/": "id/404.html" },
  redirects: [
    { from: "/cv.pdf", to: "/cv-en.pdf", status: 301 },
    { from: "/", to: "/id/", status: 302, when: { cookie: "lang=id" } },
    { from: "/", to: "/en/", status: 302, when: { cookie: "lang=en" } },
    { from: "/", to: "/id/", status: 302, when: { header: "Accept-Language", prefix: "id" } },
    { from: "/", to: "/en/", status: 302 },
  ],
};

describe("situs statis disajikan Caddy", { skip: hasDocker ? false : "Docker tidak tersedia" }, () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let container;
  /** @type {string} */
  let port;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caddy-runtime-"));
    const release = path.join(dir, "release");
    for (const [file, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(release, "dist", file)), { recursive: true });
      fs.writeFileSync(path.join(release, "dist", file), content);
    }
    fs.mkdirSync(path.join(dir, "etc", "sites"), { recursive: true });
    fs.copyFileSync(BASE_CADDYFILE, path.join(dir, "etc", "Caddyfile"));
    fs.writeFileSync(path.join(dir, "etc", "sites", "situs.caddy"), renderCaddySite(parseManifest(MANIFEST), "/srv/current"));
    fs.chmodSync(dir, 0o755);
    const started = realRun("docker", [
      "run", "-d", "--rm", "-p", "127.0.0.1::443",
      "-v", `${path.join(dir, "etc")}:/etc/caddy:ro`,
      "-v", `${release}:/srv/current:ro`,
      "caddy:2",
    ]);
    assert.equal(started.status, 0, started.stderr);
    container = started.stdout.trim();
    port = realRun("docker", ["port", container, "443/tcp"]).stdout.trim().split(":").at(-1) ?? "";
    for (let i = 0; i < 50; i += 1) {
      if (get("/en/").status === 200) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Caddy tidak siap: ${realRun("docker", ["logs", container]).stderr.slice(-1500)}`);
  });

  after(() => {
    if (container) realRun("docker", ["rm", "-f", container]);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath
   * @param {string[]} [headers]
   * @param {string} [host]
   */
  function get(urlPath, headers = [], host = "situs.localhost") {
    const result = realRun("curl", [
      "-sk", "--max-time", "5", "-D", "-",
      "--resolve", `${host}:${port}:127.0.0.1`,
      ...headers.flatMap((h) => ["-H", h]),
      `https://${host}:${port}${urlPath}`,
    ]);
    const [head = "", ...rest] = result.stdout.split("\r\n\r\n");
    const lines = head.split("\r\n");
    const status = Number(lines[0]?.split(" ")[1] ?? 0);
    /** @type {Record<string, string>} */
    const h = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) h[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status, headers: h, body: rest.join("\r\n\r\n") };
  }

  it("clean URL dan header keamanan; Server disembunyikan", () => {
    const card = get("/card");
    assert.equal(card.status, 200);
    assert.equal(card.body, "card-page");
    const en = get("/en/");
    assert.equal(en.body, "en-index");
    assert.equal(en.headers["content-security-policy"], "default-src 'self'; img-src 'self' data:");
    assert.equal(en.headers["x-content-type-options"], "nosniff");
    assert.equal(en.headers.server, undefined);
  });

  it("cache: /_astro/* setahun, selain itu no-cache", () => {
    assert.equal(get("/_astro/app.abc123.js").headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(get("/en/").headers["cache-control"], "no-cache");
    assert.equal(get("/card").headers["cache-control"], "no-cache");
  });

  it("404 per awalan dengan status 404 dan header keamanan", () => {
    const en = get("/tidak-ada");
    assert.equal(en.status, 404);
    assert.equal(en.body, "not-found-en");
    assert.equal(en.headers["content-security-policy"], "default-src 'self'; img-src 'self' data:");
    const id = get("/id/tidak-ada");
    assert.equal(id.status, 404);
    assert.equal(id.body, "not-found-id");
  });

  it("redirect: /cv.pdf, dan / per cookie lalu Accept-Language", () => {
    const cv = get("/cv.pdf");
    assert.equal(cv.status, 301);
    assert.equal(cv.headers.location, "/cv-en.pdf");
    assert.equal(get("/", ["Cookie: lang=id"]).headers.location, "/id/");
    assert.equal(get("/", ["Cookie: theme=dark; lang=en", "Accept-Language: id-ID,id;q=0.9"]).headers.location, "/en/");
    assert.equal(get("/", ["Accept-Language: id-ID,id;q=0.9"]).headers.location, "/id/");
    const plain = get("/");
    assert.equal(plain.status, 302);
    assert.equal(plain.headers.location, "/en/");
  });

  it("Content-Type per file menimpa tebakan file_server", () => {
    const vcf = get("/kartu.vcf");
    assert.equal(vcf.status, 200);
    assert.equal(vcf.headers["content-type"], "text/vcard; charset=utf-8");
  });

  it("www dialihkan permanen ke domain utama", () => {
    const www = get("/halaman?a=1", [], "www.situs.localhost");
    assert.equal(www.status, 301);
    assert.equal(www.headers.location, "https://situs.localhost/halaman?a=1");
  });
});
