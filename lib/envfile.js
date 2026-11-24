// @ts-check
// File .env per app (/srv/apps/<name>/shared/.env), dibaca systemd lewat EnvironmentFile.
// Pesan error hanya menyebut nomor baris dan nama variabel, tidak pernah nilainya.

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * @param {string} text
 * @returns {{ keys: string[], problems: string[] }}
 */
export function checkEnvFile(text) {
  /** @type {string[]} */
  const keys = [];
  /** @type {string[]} */
  const problems = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const match = LINE_RE.exec(line);
    if (match === null) {
      problems.push(`baris ${index + 1}: harus berbentuk NAMA=nilai (tanpa spasi sebelum "=")`);
      return;
    }
    const key = /** @type {string} */ (match[1]);
    if (keys.includes(key)) problems.push(`baris ${index + 1}: ${key} sudah ditulis sebelumnya`);
    else keys.push(key);
  });
  return { keys, problems };
}

/**
 * Variabel wajib yang belum diisi (tidak ada, atau nilainya kosong).
 * @param {string} text
 * @param {string[]} required
 * @returns {string[]}
 */
export function missingEnv(text, required) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (const rawLine of text.split("\n")) {
    const match = LINE_RE.exec(rawLine.replace(/\r$/, ""));
    if (match !== null) values.set(/** @type {string} */ (match[1]), (match[2] ?? "").trim());
  }
  return required.filter((key) => !values.get(key));
}
