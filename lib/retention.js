// @ts-check
// Retensi backup (fungsi murni): simpan backup terbaru per hari, per minggu ISO, dan per bulan,
// untuk N hari/minggu/bulan TERAKHIR YANG PUNYA BACKUP (seperti restic --keep-daily/weekly/monthly).
// Jadi kalau backup sempat berhenti lama, backup lama tidak ikut terbuang; jumlah yang disimpan
// tetap paling banyak daily + weekly + monthly. Nama objek memuat waktu backup (lib/backup.js
// objectKey), jadi tidak bergantung pada metadata R2.

const DAY = 86_400_000;

/** @typedef {{ daily: number, weekly: number, monthly: number }} RetentionPolicy */
export const DEFAULT_RETENTION = { daily: 14, weekly: 8, monthly: 6 };

/** apps/<app>/2026-11-25T20-00-03Z.tar.gz.spb → waktu (ms), atau null kalau bukan nama backup. */
const KEY_RE = /\/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.tar\.gz\.spb$/;

/** @param {string} key */
export function backupTime(key) {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const time = Date.UTC(/** @type {number} */ (y), /** @type {number} */ (mo) - 1, d, h, mi, s);
  return Number.isNaN(time) ? null : time;
}

/** Minggu ISO 8601 (mis. "2026-W48"): minggu milik tahun tempat hari Kamis-nya berada. */
function isoWeek(/** @type {number} */ time) {
  const date = new Date(time);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Objek mana yang dihapus. Yang tidak pernah dihapus: nama yang bukan backup, backup yang
 * lebih muda dari 2 hari, dan backup terbaru.
 * @param {string[]} keys
 * @param {number} now
 * @param {RetentionPolicy} [policy]
 * @returns {{ keep: string[], remove: string[] }}
 */
export function planRetention(keys, now, policy = DEFAULT_RETENTION) {
  const backups = keys
    .map((key) => ({ key, time: backupTime(key) }))
    .filter((/** @type {{ key: string, time: number | null }} */ b) => b.time !== null)
    .sort((a, b) => /** @type {number} */ (b.time) - /** @type {number} */ (a.time));
  const keep = new Set(/** @type {string[]} */ ([]));
  if (backups[0]) keep.add(backups[0].key);

  /**
   * @param {(time: number) => string} bucket
   * @param {number} count
   */
  const keepNewestPer = (bucket, count) => {
    const seen = new Set();
    for (const b of backups) {
      const id = bucket(/** @type {number} */ (b.time));
      if (seen.has(id)) continue;
      if (seen.size >= count) break;
      seen.add(id);
      keep.add(b.key);
    }
  };
  keepNewestPer((t) => new Date(t).toISOString().slice(0, 10), policy.daily);
  keepNewestPer(isoWeek, policy.weekly);
  keepNewestPer((t) => new Date(t).toISOString().slice(0, 7), policy.monthly);
  for (const b of backups) if (now - /** @type {number} */ (b.time) < 2 * DAY) keep.add(b.key);

  return {
    keep: backups.filter((b) => keep.has(b.key)).map((b) => b.key),
    remove: backups.filter((b) => !keep.has(b.key)).map((b) => b.key),
  };
}

export { isoWeek as _isoWeek };
