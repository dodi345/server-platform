#!/usr/bin/env node
// @ts-check
// Snapshot satu database SQLite dengan API backup SQLite (aman walau app sedang menulis).
// Dijalankan lib/backup.js sebagai USER APP (bukan root): kalau root membuka database WAL, file
// -wal/-shm bisa jadi milik root dan app tidak bisa menulis lagi.
//
//   node lib/sqlite-snapshot.js <sumber.db> <tujuan.db>
// Keluaran: satu baris JSON { ok, integrity, bytes } atau { ok: false, error }.
import fs from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";

const [source, target] = process.argv.slice(2);
try {
  if (!source || !target) throw new Error("pemakaian: sqlite-snapshot <sumber> <tujuan>");
  const db = new DatabaseSync(source);
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  // Hasil snapshot dijadikan satu file mandiri (tanpa -wal) lalu dicek integritasnya.
  const copy = new DatabaseSync(target);
  let integrity = "";
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    const rows = /** @type {{ integrity_check: string }[]} */ (copy.prepare("PRAGMA integrity_check").all());
    integrity = rows.map((r) => r.integrity_check).join("; ");
  } finally {
    copy.close();
  }
  process.stdout.write(`${JSON.stringify({ ok: integrity === "ok", integrity, bytes: fs.statSync(target).size })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
