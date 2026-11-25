// @ts-check
// Enkripsi backup: X25519 (kunci sementara per file) + HKDF-SHA256 + AES-256-GCM.
// Server hanya menyimpan KUNCI PUBLIK, jadi backup yang sudah diunggah tidak bisa dibuka dari
// server (atau oleh siapa pun yang mencuri token R2). Kunci privat dipegang pemilik, dipakai
// hanya saat restore/verify.
//
// Format file (.spb):
//   "SPB1" (4 byte) | kunci publik sementara (32) | nonce (12) | ciphertext | tag GCM (16)
// Header (48 byte pertama) ikut diautentikasi sebagai AAD.
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("SPB1");
const HEADER_LENGTH = 4 + 32 + 12;
const TAG_LENGTH = 16;
const INFO = Buffer.from("server-platform backup v1");
export const PUBLIC_PREFIX = "spb-pub-";
export const PRIVATE_PREFIX = "spb-priv-";

export class BackupKeyError extends Error {}

/** @param {crypto.KeyObject} key */
const rawPublic = (key) => Buffer.from(/** @type {string} */ (key.export({ format: "jwk" }).x), "base64url");

/** Pasangan kunci baru, dalam bentuk teks yang bisa disalin. */
export function generateBackupKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: `${PUBLIC_PREFIX}${rawPublic(publicKey).toString("base64url")}`,
    privateKey: `${PRIVATE_PREFIX}${/** @type {string} */ (jwk.d)}`,
  };
}

/** Kunci publik dari teks; melempar BackupKeyError kalau formatnya salah. */
export function parsePublic(/** @type {string} */ text) {
  const raw = text.trim();
  if (!raw.startsWith(PUBLIC_PREFIX)) throw new BackupKeyError(`kunci publik harus diawali ${PUBLIC_PREFIX}`);
  const x = raw.slice(PUBLIC_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) throw new BackupKeyError("kunci publik rusak");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
}

/** Awalan DER PKCS#8 untuk kunci privat X25519 (OID 1.3.101.110), diikuti 32 byte kunci. */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * Kunci privat dari teks; kunci publiknya ikut dihitung (untuk dicocokkan dengan config).
 * @param {string} text
 */
export function parsePrivateKey(text) {
  const raw = text.trim();
  if (!raw.startsWith(PRIVATE_PREFIX)) throw new BackupKeyError(`kunci privat harus diawali ${PRIVATE_PREFIX}`);
  const d = raw.slice(PRIVATE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(d)) throw new BackupKeyError("kunci privat rusak");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(d, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey: `${PUBLIC_PREFIX}${rawPublic(publicKey).toString("base64url")}` };
}

/**
 * @param {Buffer} shared
 * @param {Buffer} ephemeral
 * @param {Buffer} recipient
 */
function deriveKey(shared, ephemeral, recipient) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

/**
 * Enkripsi file `src` ke `dst` untuk pemegang kunci privat pasangan `publicKeyText`.
 * @param {string} src
 * @param {string} dst
 * @param {string} publicKeyText
 */
export async function encryptFile(src, dst, publicKeyText) {
  const recipient = parsePublic(publicKeyText);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralRaw = rawPublic(ephemeral.publicKey);
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveKey(shared, ephemeralRaw, rawPublic(recipient));
  const nonce = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, ephemeralRaw, nonce]);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(header);
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (/** @type {unknown} */ error) => (error ? reject(error) : resolve(undefined))));
}

/**
 * Buka file .spb ke `dst`. Gagal (tanpa menulis hasil setengah jadi) kalau kunci salah atau
 * file diubah.
 * @param {string} src
 * @param {string} dst
 * @param {string} privateKeyText
 */
export async function decryptFile(src, dst, privateKeyText) {
  const { privateKey, publicKey } = parsePrivateKey(privateKeyText);
  const size = fs.statSync(src).size;
  if (size < HEADER_LENGTH + TAG_LENGTH) throw new BackupKeyError("file backup terlalu pendek / rusak");
  const fd = fs.openSync(src, "r");
  const header = Buffer.alloc(HEADER_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    fs.readSync(fd, header, 0, HEADER_LENGTH, 0);
    fs.readSync(fd, tag, 0, TAG_LENGTH, size - TAG_LENGTH);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 4).equals(MAGIC)) throw new BackupKeyError("bukan file backup server-platform (SPB1)");
  const ephemeralRaw = header.subarray(4, 36);
  const nonce = header.subarray(36, 48);
  const ephemeral = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ephemeralRaw.toString("base64url") }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeral });
  const recipientRaw = Buffer.from(publicKey.slice(PUBLIC_PREFIX.length), "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(shared, ephemeralRaw, recipientRaw), nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    await pipeline(fs.createReadStream(src, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 }), decipher, fs.createWriteStream(tmp, { mode: 0o600 }));
    fs.renameSync(tmp, dst);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if (error instanceof Error && /unable to authenticate|auth/i.test(error.message)) {
      throw new BackupKeyError("tidak bisa dibuka: kunci privat salah, atau file rusak/diubah");
    }
    throw error;
  }
}
