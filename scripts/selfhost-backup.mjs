import Database from "better-sqlite3";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const databasePath = resolve(process.env.DJMIMA_DATABASE_PATH || "/app/data/djmima.sqlite");
const backupDirectory = resolve(process.env.DJMIMA_BACKUP_DIR || "/app/data/backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(backupDirectory, `djmima-${timestamp}.sqlite`);
const temporaryDestination = `${destination}.partial`;
const sidecarSuffixes = ["", "-wal", "-shm", "-journal"];
const stalePartialAgeMs = 24 * 60 * 60_000;

async function removeSqliteFileSet(path) {
  await Promise.all(sidecarSuffixes.map((suffix) => rm(`${path}${suffix}`, { force: true })));
}

async function removeStalePartialFiles() {
  const cutoff = Date.now() - stalePartialAgeMs;
  const entries = await readdir(backupDirectory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^djmima-[\dT-]+Z\.sqlite\.partial(?:-(?:wal|shm)|-journal)?$/.test(entry.name))
    .map(async (entry) => {
      const path = join(backupDirectory, entry.name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }));
}

await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
await removeStalePartialFiles();
try {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(temporaryDestination);
  } finally {
    database.close();
  }
  const backup = new Database(temporaryDestination, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").pluck().get();
    if (integrity !== "ok") throw new Error(`SQLite backup integrity check failed: ${String(integrity)}`);
  } finally {
    backup.close();
  }
  await rename(temporaryDestination, destination);
} finally {
  // SQLite can leave WAL/SHM/journal companions when a backup or integrity
  // check is interrupted. They are temporary data too and must not accumulate.
  await removeSqliteFileSet(temporaryDestination);
}

const backups = (await readdir(backupDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^djmima-[\dT-]+Z\.sqlite$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .reverse();
await Promise.all(backups.slice(14).map((entry) => removeSqliteFileSet(join(backupDirectory, basename(entry)))));
console.log(`Created verified SQLite online backup: ${destination}`);
