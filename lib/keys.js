// @ts-check
// Baris authorized_keys user "deploy": satu key per app, dikunci ke perintah deploy app itu saja.

const KEY_RE = /^(ssh-ed25519) ([A-Za-z0-9+/=]+)(?: .*)?$/;

/**
 * @param {string} name
 * @param {string} publicKey isi file .pub (ssh-ed25519 AAAA... komentar)
 * @param {string} deploySsh path skrip app-deploy-ssh
 */
export function authorizedKeyLine(name, publicKey, deploySsh) {
  const match = KEY_RE.exec(publicKey.trim());
  if (match === null) throw new Error("public key harus ssh-ed25519");
  return `restrict,command="${deploySsh} ${name}" ${match[1]} ${match[2]} deploy-${name}`;
}

/**
 * Isi authorized_keys tanpa key milik app `name`.
 * @param {string} text
 * @param {string} name
 */
export function withoutAppKey(text, name) {
  const marker = ` deploy-${name}`;
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.endsWith(marker))
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * Baris known_hosts untuk GitHub Actions dari public host key server.
 * @param {string} hostKeyPub isi /etc/ssh/ssh_host_ed25519_key.pub
 */
export function hostKeyValue(hostKeyPub) {
  const [type, key] = hostKeyPub.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || key === undefined) throw new Error("host key ed25519 tidak ditemukan");
  return `${type} ${key}`;
}
