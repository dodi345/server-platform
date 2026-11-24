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
    if (match !== null) values.set(/** @type {string} */ (match[1]), (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return required.filter((key) => !values.get(key));
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_LENGTH = 8192;
/** Nilai yang aman ditulis tanpa kutip di EnvironmentFile systemd. */
const PLAIN_VALUE_RE = /^[A-Za-z0-9_.,:/@+=%-]*$/;

/**
 * Masalah pada nilai env (null = boleh). Pesan tidak pernah memuat nilainya.
 * @param {string} key
 * @param {unknown} value
 */
export function envValueProblem(key, value) {
  if (!ENV_KEY_RE.test(key)) return "nama variabel: huruf/angka/_, tidak diawali angka";
  if (typeof value !== "string") return `${key}: nilai harus teks`;
  if (value.length > MAX_VALUE_LENGTH) return `${key}: nilai maksimal ${MAX_VALUE_LENGTH} karakter`;
  if (/[\r\n\0]/.test(value)) return `${key}: nilai harus satu baris`;
  return null;
}

/**
 * Satu baris KEY=nilai. Nilai berkarakter khusus diberi kutip ganda dengan \ dan " di-escape,
 * sesuai aturan EnvironmentFile systemd (tanpa ekspansi $).
 * @param {string} key
 * @param {string} value
 */
export function formatEnvLine(key, value) {
  if (PLAIN_VALUE_RE.test(value)) return `${key}=${value}`;
  return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Ganti (atau tambahkan di akhir) KEY di isi .env. Baris lain, komentar, dan urutan tetap.
 * @param {string} text
 * @param {string} key
 * @param {string} value
 */
export function setEnvValue(text, key, value) {
  const problem = envValueProblem(key, value);
  if (problem !== null) throw new RangeError(problem);
  const line = formatEnvLine(key, value);
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  let replaced = false;
  const out = [];
  for (const current of lines) {
    if (LINE_RE.exec(current.replace(/\r$/, ""))?.[1] === key) {
      if (!replaced) out.push(line);
      replaced = true;
    } else {
      out.push(current);
    }
  }
  if (!replaced) out.push(line);
  return `${out.join("\n")}\n`;
}

/**
 * Hapus KEY dari isi .env (semua barisnya).
 * @param {string} text
 * @param {string} key
 */
export function unsetEnvValue(text, key) {
  if (!ENV_KEY_RE.test(key)) throw new RangeError("nama variabel tidak valid");
  if (text === "") return "";
  const kept = text
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => LINE_RE.exec(line.replace(/\r$/, ""))?.[1] !== key);
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}
