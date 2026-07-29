import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const primaryAccount = "admin01";
const primaryPassword = "SmokeAdminPassword!2026";
const primaryTotpSecret = "JBSWY3DPEHPK3PXP";
const setupToken = "s".repeat(48);
const setupExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

function base64Url(byte) {
  return Buffer.alloc(32, byte).toString("base64url");
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "Unable to allocate a local test port.");
  const { port } = address;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const bytes = [];
  for (const character of value.replace(/=+$/u, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    assert(index >= 0, "The smoke-test TOTP secret must be valid Base32.");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

async function totpCode(secret, now = Date.now()) {
  const counter = Math.floor(now / 30_000);
  const message = new Uint8Array(8);
  let remaining = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey("raw", decodeBase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = signature[signature.length - 1] & 0x0f;
  const value = ((signature[offset] & 0x7f) << 24)
    | (signature[offset + 1] << 16)
    | (signature[offset + 2] << 8)
    | signature[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const databaseDirectory = await mkdtemp(join(tmpdir(), "djmima-production-smoke-"));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let diagnostics = "";
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      DJMIMA_DATABASE_PATH: join(databaseDirectory, "djmima.sqlite"),
      DJMIMA_BACKUP_DIR: join(databaseDirectory, "backups"),
      DJMIMA_PUBLIC_ORIGIN: origin,
      DJMIMA_TRUST_PROXY: "1",
      PRIMARY_ADMIN_ACCOUNT: primaryAccount,
      PRIMARY_ADMIN_TOTP_SECRET: primaryTotpSecret,
      SELFHOST_SETUP_TOKEN: setupToken,
      SELFHOST_SETUP_EXPIRES_AT: setupExpiresAt,
      VAULT_ENCRYPTION_KEY: base64Url(17),
      VAULT_AUDIT_SIGNING_KEY: base64Url(29),
      AUTH_TOTP_ENCRYPTION_KEY: base64Url(43),
      LOGIN_TOKEN_HASH_KEY: base64Url(59),
      DJMIMA_ALLOW_MANUAL_ACTIVATION_CODES: "1",
      // Intentionally omit GeoIP and SMTP. Production must fail closed and
      // report both prerequisites rather than silently accepting a login.
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_000); });

  async function request(path, options = {}) {
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    headers.set("x-real-ip", "203.0.113.8");
    if (method !== "GET" && method !== "HEAD") {
      headers.set("Origin", origin);
      headers.set("Sec-Fetch-Site", "same-origin");
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${origin}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });
  }

  async function expectStatus(response, status, description) {
    if (response.status === status) return;
    throw new Error(`${description}: expected HTTP ${status}, got ${response.status}: ${await response.text()}\n${diagnostics}`);
  }

  try {
    let loginPage;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        loginPage = await request("/login");
        if (loginPage.ok) break;
      } catch {
        // Server still starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert(loginPage, `Production server did not start. ${diagnostics}`);
    await expectStatus(loginPage, 200, "Production login page");
    assert.doesNotMatch(loginPage.headers.get("content-security-policy") ?? "", /unsafe-eval/u, "Production CSP must not allow eval.");

    const liveness = await request("/api/health?mode=live");
    await expectStatus(liveness, 200, "Production liveness before initial setup");
    assert.deepEqual(await liveness.json(), { status: "ok" }, "Liveness must not depend on setup, GeoIP or SMTP.");

    const health = await request("/api/health");
    await expectStatus(health, 503, "Production readiness without GeoIP and SMTP");
    const healthPayload = await health.json();
    assert(healthPayload.issues?.includes("GEOIP_DATABASE_UNAVAILABLE"), "Missing GeoIP must fail readiness.");
    assert(healthPayload.issues?.includes("SECURITY_EMAIL_UNAVAILABLE"), "Missing SMTP must fail readiness.");

    const retiredAccessRoute = await request("/api/login-access");
    await expectStatus(retiredAccessRoute, 404, "Retired IP/device management API");

    const setup = await request("/api/setup/complete", {
      method: "POST",
      body: { token: setupToken, password: primaryPassword, securityEmail: "admin@example.test" },
    });
    await expectStatus(setup, 200, "Initial setup");
    const setupPayload = await setup.json();
    assert.equal(setupPayload.recoveryCodes?.length, 10, "Initial setup must create ten offline administrator recovery codes.");

    const missingTotpLogin = await request("/api/auth/login", {
      method: "POST",
      body: { email: primaryAccount, password: primaryPassword, userCode: "", returnTo: "/" },
    });
    await expectStatus(missingTotpLogin, 401, "Reject login without a Google verification code");

    const blockedLogin = await request("/api/auth/login", {
      method: "POST",
      body: { email: primaryAccount, password: primaryPassword, userCode: await totpCode(primaryTotpSecret), returnTo: "/" },
    });
    await expectStatus(blockedLogin, 503, "Production login without a GeoIP database");
  } finally {
    await stopProcess(child);
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

await main();
console.log("Production smoke test passed (fail-closed readiness and retired access routes).");
