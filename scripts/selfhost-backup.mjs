import Database from "better-sqlite3";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
await rename(temporaryDestination, destination);

const backups = (await readdir(backupDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^djmima-[\dT-]+Z\.sqlite$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .reverse();
await Promise.all(backups.slice(14).map((entry) => rm(join(backupDirectory, basename(entry)))));
console.log(`Created SQLite online backup: ${destination}`);
