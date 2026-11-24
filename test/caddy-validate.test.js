// @ts-check
// Validasi config hasil render dengan Caddy sungguhan (image Docker resmi). Dilewati kalau
// Docker tidak ada. Menjaga sintaks Caddyfile, bukan hanya string-nya.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { renderCaddySite } from "../lib/render.js";
import { realRun } from "../lib/system.js";
import { nodeManifest } from "./helpers.js";

const CADDY_IMAGE = "caddy:2";
const BASE_CADDYFILE = fileURLToPath(new URL("../caddy/Caddyfile", import.meta.url));
const hasDocker = realRun("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;

/** @param {Record<string, string>} sites nama file → isi */
function validate(sites) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caddy-validate-"));
  try {
    fs.copyFileSync(BASE_CADDYFILE, path.join(dir, "Caddyfile"));
    fs.mkdirSync(path.join(dir, "sites"));
    for (const [file, content] of Object.entries(sites)) fs.writeFileSync(path.join(dir, "sites", file), content);
    fs.chmodSync(dir, 0o755);
    return realRun("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${dir}:/etc/caddy:ro`,
      CADDY_IMAGE,
      "caddy",
      "validate",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("Caddyfile valid menurut Caddy", { skip: hasDocker ? false : "Docker tidak tersedia" }, () => {
  it("config utama tanpa situs (server baru)", () => {
    const result = validate({});
    assert.equal(result.status, 0, result.stderr);
  });

  it("situs node + statis (SPA, 404, redirect www) sekaligus", () => {
    const api = parseManifest(nodeManifest("words", { domains: ["words.stackfolio.web.id"] }));
    const site = parseManifest({
      name: "situs",
      type: "static",
      domains: ["contoh.com", "www.contoh.com"],
      redirect_www: true,
      package: ["dist"],
      root: "dist",
      spa: true,
      not_found: "404.html",
    });
    const result = validate({
      "words.caddy": renderCaddySite(api, "/srv/apps/words/current"),
      "situs.caddy": renderCaddySite(site, "/srv/apps/situs/current"),
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it("config rusak memang ditolak (validasi bekerja)", () => {
    const result = validate({ "rusak.caddy": "contoh.com {\n\treverse_proxy\n" });
    assert.notEqual(result.status, 0);
  });
});
