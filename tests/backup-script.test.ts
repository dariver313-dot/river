import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

test("备份脚本清理过期 partial sidecar 并为正式备份保留完整文件集", () => {
  const directory = mkdtempSync(join(tmpdir(), "djmima-backup-"));
  const databasePath = join(directory, "source.sqlite");
  const backupDirectory = join(directory, "backups");

  try {
    const database = new Database(databasePath);
    database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample (value) VALUES ('verified');");
    database.close();
    mkdirSync(backupDirectory);

    for (let day = 1; day <= 15; day += 1) {
      const name = `djmima-2026-01-${String(day).padStart(2, "0")}T00-00-00-000Z.sqlite`;
      writeFileSync(join(backupDirectory, name), "historical");
      if (day === 1) {
        writeFileSync(join(backupDirectory, `${name}-wal`), "sidecar");
        writeFileSync(join(backupDirectory, `${name}-shm`), "sidecar");
      }
    }

    const stalePartial = join(backupDirectory, "djmima-2025-12-01T00-00-00-000Z.sqlite.partial");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const path = `${stalePartial}${suffix}`;
      closeSync(openSync(path, "w"));
      const old = new Date(Date.now() - 48 * 60 * 60_000);
      utimesSync(path, old, old);
    }

    const child = spawnSync(process.execPath, [resolve("scripts/selfhost-backup.mjs")], {
      cwd: resolve("."),
      env: { ...process.env, DJMIMA_DATABASE_PATH: databasePath, DJMIMA_BACKUP_DIR: backupDirectory },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);

    const files = readdirSync(backupDirectory);
    const formalBackups = files.filter((name) => /^djmima-[\dT-]+Z\.sqlite$/.test(name));
    assert.equal(formalBackups.length, 14);
    assert.equal(files.some((name) => name.includes(".partial")), false);
    assert.equal(files.includes("djmima-2026-01-01T00-00-00-000Z.sqlite-wal"), false);
    assert.equal(files.includes("djmima-2026-01-01T00-00-00-000Z.sqlite-shm"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
