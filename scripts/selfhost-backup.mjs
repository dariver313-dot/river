import Database from "better-sqlite3";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const databasePath = resolve(process.env.DJMIMA_DATABASE_PATH || "/app/data/djmima.sqlite");
const backupDirectory = resolve(process.env.DJMIMA_BACKUP_DIR || "/app/data/backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(backupDirectory, `djmima-${timestamp}.sqlite`);
const temporaryDestination = `${destination}.partial`;

await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  await database.backup(temporaryDestination);
} finally {
  database.close();
}

let verified = false;
try {
  const backup = new Database(temporaryDestination, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").pluck().get();
    if (integrity !== "ok") throw new Error(`SQLite backup integrity check failed: ${String(integrity)}`);
  } finally {
    backup.close();
  }
  await rename(temporaryDestination, destination);
  verified = true;
} finally {
  if (!verified) await rm(temporaryDestination, { force: true });
}

const backups = (await readdir(backupDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^djmima-[\dT-]+Z\.sqlite$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .reverse();
await Promise.all(backups.slice(14).map((entry) => rm(join(backupDirectory, basename(entry)))));
console.log(`Created verified SQLite online backup: ${destination}`);
