// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkEnvFile, missingEnv } from "../lib/envfile.js";
import { authorizedKeyLine, hostKeyValue, withoutAppKey } from "../lib/keys.js";
import { parseManifest } from "../lib/manifest.js";
import { renderCaddySite, renderSystemdDropIn } from "../lib/render.js";
import { nodeManifest } from "./helpers.js";

describe("renderCaddySite", () => {
  it("app node: reverse proxy ke 127.0.0.1:<port>", () => {
    const m = parseManifest(nodeManifest("words", { domains: ["words.stackfolio.web.id"], port: 4300 }));
    assert.equal(
      renderCaddySite(m, "/srv/apps/words/current"),
      [
        '# server-platform: dibuat otomatis dari deploy.json app "words". Jangan diedit manual.',
        "words.stackfolio.web.id {",
        "\tencode zstd gzip",
        "\theader -Server",
        "\treverse_proxy 127.0.0.1:4300 {",
        "\t\theader_up X-Real-IP {client_ip}",
        "\t}",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("situs statis: root, SPA, halaman 404, redirect www", () => {
    const m = parseManifest({
      name: "situs",
      type: "static",
      domains: ["contoh.com", "www.contoh.com"],
      redirect_www: true,
      package: ["dist"],
      root: "dist",
      spa: true,
      not_found: "404.html",
    });
    const site = renderCaddySite(m, "/srv/apps/situs/current");
    assert.match(site, /^contoh\.com \{$/m);
    assert.match(site, /^\t\troot \* \/srv\/apps\/situs\/current\/dist$/m);
    assert.match(site, /^\t\ttry_files \{path\} \/index\.html$/m);
    assert.match(site, /^\t\t\trewrite \* \/404\.html$/m);
    assert.match(site, /^\t\theader Cache-Control "no-cache"$/m);
    assert.match(site, /^www\.contoh\.com \{\n\tredir https:\/\/contoh\.com\{uri\} permanent\n\}$/m);
  });

  it("root '.' = folder release itu sendiri", () => {
    const m = parseManifest({ name: "situs", type: "static", domains: ["a.com"], package: ["index.html"] });
    assert.match(renderCaddySite(m, "/srv/apps/situs/current"), /^\t\troot \* \/srv\/apps\/situs\/current$/m);
  });

  it("header, cache immutable, header per file, redirect bersyarat, clean URL, 404 per awalan", () => {
    const m = parseManifest({
      name: "situs",
      type: "static",
      domains: ["a.com"],
      package: ["dist"],
      root: "dist",
      clean_urls: true,
      headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; img-src 'self' data:" },
      file_headers: { "/kartu.vcf": { "Content-Type": "text/vcard; charset=utf-8" } },
      immutable: ["/_astro/*"],
      not_found: { "/": "404.html", "/id/": "id/404.html" },
      redirects: [
        { from: "/cv.pdf", to: "/cv-en.pdf", status: 301 },
        { from: "/", to: "/id/", status: 302, when: { cookie: "lang=id" } },
        { from: "/", to: "/id/", status: 302, when: { header: "Accept-Language", prefix: "id" } },
        { from: "/", to: "/en/", status: 302 },
      ],
    });
    const site = renderCaddySite(m, "/srv/apps/situs/current");
    assert.match(site, /^\t\t\tContent-Security-Policy "default-src 'self'; img-src 'self' data:"$/m);
    assert.match(site, /^\t@immutable path \/_astro\/\*$/m);
    assert.match(site, /^\t@revalidate not path \/_astro\/\*$/m);
    assert.match(site, /^\t\theader @file0 >Content-Type "text\/vcard; charset=utf-8"$/m);
    assert.match(site, /^\t\texpression `\{http\.request\.cookie\.lang\} == "id"`$/m);
    assert.match(site, /^\t\theader Accept-Language id\*$/m);
    // Urutan redirect = urutan di deploy.json (di dalam route).
    const order = [...site.matchAll(/^\t\tredir @redirect(\d) (\S+) (\d+)$/gm)].map((x) => `${x[1]}:${x[2]}:${x[3]}`);
    assert.deepEqual(order, ["0:/cv-en.pdf:301", "1:/id/:302", "2:/id/:302", "3:/en/:302"]);
    assert.match(site, /^\t\ttry_files \{path\} \{path\}\.html \{path\}\/index\.html$/m);
    // 404: awalan terpanjang dulu, dan "/" mengecualikan "/id/".
    assert.match(site, /@notfound0 \{\n\t\t\texpression `\{err\.status_code\} == 404`\n\t\t\tpath \/id\/\*\n\t\t\}/);
    assert.match(site, /@notfound1 \{\n\t\t\texpression `\{err\.status_code\} == 404`\n\t\t\tpath \/\*\n\t\t\tnot path \/id\/\*\n\t\t\}/);
    assert.match(site, /^\t\t\trewrite \* \/id\/404\.html$/m);
  });
});

describe("renderSystemdDropIn", () => {
  it("ExecStart dengan path node absolut + MemoryMax", () => {
    const m = parseManifest(nodeManifest("words", { start: ["node", "dist/bot/index.js"], memory: "256M" }));
    if (m.type !== "node") throw new Error("node");
    assert.equal(
      renderSystemdDropIn(m, "/usr/bin/node"),
      '# server-platform: dibuat otomatis dari deploy.json app "words". Jangan diedit manual.\n[Service]\nExecStart=/usr/bin/node dist/bot/index.js\nMemoryMax=256M\n',
    );
  });
});

describe("env file", () => {
  it("komentar/baris kosong boleh; baris rusak dan ganda dilaporkan tanpa menampilkan nilai", () => {
    const { keys, problems } = checkEnvFile("# komentar\n\nTOKEN=rahasia-123\nTOKEN=lagi\nSALAH ini=rahasia-456\nURL=https://x.y/?a=b\n");
    assert.deepEqual(keys, ["TOKEN", "URL"]);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => !p.includes("rahasia")));
  });

  it("variabel wajib: tidak ada atau kosong = belum diisi", () => {
    assert.deepEqual(missingEnv("A=1\nB=\n", ["A", "B", "C"]), ["B", "C"]);
  });
});

describe("authorized_keys", () => {
  const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample komentar";

  it("key dikunci ke perintah deploy app itu", () => {
    assert.equal(
      authorizedKeyLine("words", pub, "/usr/local/bin/app-deploy-ssh"),
      'restrict,command="/usr/local/bin/app-deploy-ssh words" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample deploy-words',
    );
    assert.throws(() => authorizedKeyLine("words", "ssh-rsa AAAA", "/x"));
  });

  it("hapus key satu app saja (nama mirip tidak ikut terhapus)", () => {
    const text = [
      authorizedKeyLine("words", pub, "/x"),
      authorizedKeyLine("words2", pub, "/x"),
      "",
    ].join("\n");
    assert.equal(withoutAppKey(text, "words"), `${authorizedKeyLine("words2", pub, "/x")}\n`);
  });

  it("host key untuk known_hosts GitHub", () => {
    assert.equal(hostKeyValue("ssh-ed25519 AAAAhost root@vm\n"), "ssh-ed25519 AAAAhost");
    assert.throws(() => hostKeyValue("ssh-rsa AAAA"));
  });
});
