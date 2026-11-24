// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflicts, ManifestError, parseManifest } from "../lib/manifest.js";
import { nodeManifest } from "./helpers.js";

/** @param {unknown} value */
function problems(value) {
  try {
    parseManifest(value);
  } catch (error) {
    if (error instanceof ManifestError) return error.problems;
    throw error;
  }
  return [];
}

describe("parseManifest", () => {
  it("app node: default health, shared, memory, required_env", () => {
    const m = parseManifest({
      name: "api",
      type: "node",
      domains: ["API.Stackfolio.web.id"],
      node: "24",
      package: ["dist/", "package.json"],
      port: 4500,
      start: ["node", "dist/server.js"],
    });
    assert.equal(m.type, "node");
    assert.deepEqual(m.domains, ["api.stackfolio.web.id"]);
    assert.deepEqual(m.package, ["dist", "package.json"]);
    if (m.type !== "node") return;
    assert.equal(m.health, "/");
    assert.deepEqual(m.shared, []);
    assert.equal(m.memory, "300M");
    assert.deepEqual(m.required_env, []);
  });

  it("situs statis dengan redirect www", () => {
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
    assert.equal(m.type, "static");
    if (m.type !== "static") return;
    assert.equal(m.root, "dist");
    assert.equal(m.spa, true);
    assert.equal(m.node, null);
  });

  it("menolak nilai yang bisa menyisipkan config Caddy/systemd", () => {
    const base = nodeManifest("api");
    for (const [field, value] of /** @type {[string, unknown][]} */ ([
      ["domains", ["a.com {\n}"]],
      ["domains", ["contoh.com, evil.com"]],
      ["domains", ["-bad.com"]],
      ["start", ["node", "dist/server.js; rm -rf /"]],
      ["start", ["node", "a b"]],
      ["start", ["bash", "-c", "x"]],
      ["health", "/health {"],
      ["memory", "300M\nUser=root"],
      ["package", ["../etc"]],
      ["package", ["/etc/passwd"]],
      ["name", "Api"],
      ["name", "a"],
      ["port", 80],
      ["port", 70000],
      ["shared", ["../data"]],
    ])) {
      assert.ok(problems({ ...base, [field]: value }).some((p) => p.startsWith(field)), `${field}=${JSON.stringify(value)}`);
    }
  });

  it("field tidak dikenal, field static di app node, dan data shared ikut paket ditolak", () => {
    assert.ok(problems({ ...nodeManifest("api"), porr: 1 }).some((p) => p.startsWith("porr")));
    assert.ok(problems({ ...nodeManifest("api"), root: "dist" }).some((p) => p.startsWith("root")));
    assert.ok(
      problems({ ...nodeManifest("api"), package: ["dist", "data/app.db"] }).some((p) => p.includes('"data"')),
    );
  });

  it("redirect_www butuh domain utama dan pasangan www-nya", () => {
    const base = { name: "situs", type: "static", package: ["dist"], redirect_www: true };
    assert.ok(problems({ ...base, domains: ["contoh.com"] }).some((p) => p.startsWith("redirect_www")));
    assert.ok(problems({ ...base, domains: ["www.contoh.com"] }).some((p) => p.startsWith("redirect_www")));
    assert.deepEqual(problems({ ...base, domains: ["contoh.com", "www.contoh.com"] }), []);
  });

  it("fitur situs statis: nilai yang bisa memecah config Caddy ditolak", () => {
    const base = { name: "situs", type: "static", domains: ["a.com"], package: ["dist"] };
    for (const [field, value] of /** @type {[string, unknown][]} */ ([
      ["headers", { "X-A": 'nilai "kutip"' }],
      ["headers", { "X-A": "a\nb" }],
      ["headers", { "X-A": "{env.SECRET}" }],
      ["headers", { "X-A": "a`b" }],
      ["headers", { "Nama Header": "x" }],
      ["headers", { "Cache-Control": "no-store" }],
      ["file_headers", { "/a/*": { "Content-Type": "x" } }],
      ["file_headers", { "relatif": { "Content-Type": "x" } }],
      ["immutable", ["_astro/*"]],
      ["immutable", ["/a b/*"]],
      ["not_found", { "/id": "id/404.html" }],
      ["not_found", { "/": "../404.html" }],
      ["redirects", [{ from: "/a", to: "/b", status: 200 }]],
      ["redirects", [{ from: "/a b", to: "/b" }]],
      ["redirects", [{ from: "/a", to: "http://x.com/" }]],
      ["redirects", [{ from: "/a", to: "/b\n}" }]],
      ["redirects", [{ from: "/", to: "/id/", when: { cookie: "lang=i d" } }]],
      ["redirects", [{ from: "/", to: "/id/", when: { header: "Accept-Language" } }]],
      ["redirects", [{ from: "/", to: "/id/", when: { cookie: "a=b", header: "X", prefix: "y" } }]],
    ])) {
      assert.ok(problems({ ...base, [field]: value }).some((p) => p.startsWith(field)), `${field}=${JSON.stringify(value)}`);
    }
    assert.ok(problems({ ...base, spa: true, clean_urls: true }).length > 0);
  });

  it("not_found string = semua path; objek diurutkan dari awalan terpanjang", () => {
    const base = { name: "situs", type: "static", domains: ["a.com"], package: ["dist"] };
    const one = parseManifest({ ...base, not_found: "404.html" });
    const many = parseManifest({ ...base, not_found: { "/": "404.html", "/id/": "id/404.html" } });
    if (one.type !== "static" || many.type !== "static") throw new Error("static");
    assert.deepEqual(one.not_found, [{ prefix: "/", file: "404.html" }]);
    assert.deepEqual(many.not_found.map((e) => e.prefix), ["/id/", "/"]);
    const redirect = parseManifest({ ...base, redirects: [{ from: "/x", to: "https://b.com/y" }] });
    if (redirect.type !== "static") throw new Error("static");
    assert.deepEqual(redirect.redirects, [{ from: "/x", to: "https://b.com/y", status: 301, when: null }]);
  });

  it("bukan objek", () => {
    assert.throws(() => parseManifest([]), ManifestError);
    assert.throws(() => parseManifest(null), ManifestError);
  });
});

describe("conflicts", () => {
  it("domain atau port yang sama dengan app lain; app sendiri diabaikan", () => {
    const a = parseManifest(nodeManifest("satu", { domains: ["x.com"], port: 4300 }));
    const b = parseManifest(nodeManifest("dua", { domains: ["x.com"], port: 4300 }));
    const c = parseManifest(nodeManifest("tiga", { domains: ["y.com"], port: 4400 }));
    assert.equal(conflicts(a, [b]).length, 2);
    assert.deepEqual(conflicts(a, [c]), []);
    assert.deepEqual(conflicts(a, [a]), []);
  });

  it("situs statis tidak punya port", () => {
    const site = parseManifest({ name: "situs", type: "static", domains: ["s.com"], package: ["dist"] });
    const api = parseManifest(nodeManifest("api"));
    assert.deepEqual(conflicts(site, [api]), []);
  });
});
