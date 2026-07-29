import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

test("legacy databases preserve retired network tables while gaining current account columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "djmima-legacy-db-"));
  const databasePath = join(directory, "legacy.sqlite");

  try {
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE app_users (
        email TEXT PRIMARY KEY NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        auth_totp_secret TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE login_ip_allowlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        cidr TEXT NOT NULL,
        label TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO login_ip_allowlist (email, cidr, label, created_by)
      VALUES ('legacy@example.com', '203.0.113.8/32', '旧账号网络', 'legacy@example.com');
    `);
    legacy.close();

    const moduleUrl = pathToFileURL(resolve("db/index.ts")).href;
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { getDatabase } from ${JSON.stringify(moduleUrl)}; await getDatabase().prepare("SELECT 1 AS healthy").bind().first();`,
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, DJMIMA_DATABASE_PATH: databasePath },
        encoding: "utf8",
      },
    );

    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);

    const upgraded = new Database(databasePath, { readonly: true });
    const userColumns = upgraded
      .prepare("PRAGMA table_info(app_users)")
      .all()
      .map((column) => column.name);
    const challengeColumns = upgraded
      .prepare("PRAGMA table_info(login_challenges)")
      .all()
      .map((column) => column.name);

    assert.ok(userColumns.includes("security_email"));
    assert.ok(userColumns.includes("security_email_verified_at"));
    assert.ok(userColumns.includes("display_name"));
    assert.ok(userColumns.includes("avatar_style"));
    assert.ok(challengeColumns.includes("browser_hash"));
    assert.equal(
      upgraded
        .prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
        .get("index", "app_users_security_email_idx") !== undefined,
      true,
    );
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM login_ip_allowlist").get().count, 1,
      "旧网络规则在升级后只保留为历史数据，不会被提升、读取或删除");
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh databases do not recreate retired IP or device tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "djmima-fresh-db-"));
  const databasePath = join(directory, "fresh.sqlite");

  try {
    const moduleUrl = pathToFileURL(resolve("db/index.ts")).href;
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { getDatabase } from ${JSON.stringify(moduleUrl)}; await getDatabase().prepare("SELECT 1 AS healthy").bind().first();`,
      ],
      { cwd: resolve("."), env: { ...process.env, DJMIMA_DATABASE_PATH: databasePath }, encoding: "utf8" },
    );
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);

    const fresh = new Database(databasePath, { readonly: true });
    for (const retiredTable of ["login_ip_allowlist", "global_login_ip_allowlist", "trusted_devices", "device_enrollments"]) {
      assert.equal(
        fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(retiredTable),
        undefined,
        `${retiredTable} must not be created for a new installation`,
      );
    }
    fresh.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("验证器恢复在最终确认前不会把新密钥变成可登录因素", () => {
  const directory = mkdtempSync(join(tmpdir(), "djmima-authenticator-reset-"));
  const databasePath = join(directory, "reset.sqlite");

  try {
    const key = Buffer.alloc(32, 71).toString("base64url");
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/jiti/lib/jiti-cli.mjs",
        "tests/fixtures/authenticator-reset-integration.ts",
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          DJMIMA_DATABASE_PATH: databasePath,
          PRIMARY_ADMIN_ACCOUNT: "admin01",
          AUTH_TOTP_ENCRYPTION_KEY: key,
          VAULT_ENCRYPTION_KEY: key,
          VAULT_AUDIT_SIGNING_KEY: key,
          LOGIN_TOKEN_HASH_KEY: key,
        },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("安全会话以数据库空闲期限为准且浏览器句柄最多保留八小时", () => {
  const directory = mkdtempSync(join(tmpdir(), "djmima-security-session-"));
  const databasePath = join(directory, "session.sqlite");

  try {
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/jiti/lib/jiti-cli.mjs",
        "tests/fixtures/security-session-integration.ts",
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, DJMIMA_DATABASE_PATH: databasePath },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("公共项目凭据访问由服务端审计，个人项目和越权读取不会写入访问事件", () => {
  const directory = mkdtempSync(join(tmpdir(), "djmima-public-access-audit-"));
  const databasePath = join(directory, "audit.sqlite");

  try {
    const key = Buffer.alloc(32, 83).toString("base64url");
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/jiti/lib/jiti-cli.mjs",
        "tests/fixtures/public-access-audit-integration.ts",
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          DJMIMA_DATABASE_PATH: databasePath,
          PRIMARY_ADMIN_ACCOUNT: "admin01",
          AUTH_TOTP_ENCRYPTION_KEY: key,
          VAULT_ENCRYPTION_KEY: key,
          VAULT_AUDIT_SIGNING_KEY: key,
          LOGIN_TOKEN_HASH_KEY: key,
        },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
