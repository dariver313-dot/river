import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/initialize-selfhost.mjs --account admin@example.com --origin https://djmima.com");
  process.exit(1);
}

function base32(bytes = 20) {
  const source = randomBytes(bytes);
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of source) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

const account = (valueAfter("--account") ?? valueAfter("--email"))?.toLowerCase();
const emailAccount = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const usernameAccount = /^(?=.{4,32}$)(?=.*[a-z])(?=.*\d)[a-z][a-z\d]*$/;
if (!account || !(emailAccount.test(account) || usernameAccount.test(account))) usage("A valid administrator account is required.");

let origin;
try {
  origin = new URL(valueAfter("--origin") ?? "");
} catch {
  usage("A valid HTTPS public origin is required.");
}
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
  usage("The origin must be a bare HTTPS address, for example https://djmima.com.");
}

const envPath = resolve(".env");
const setupPath = resolve(".selfhost-setup-url");
if (existsSync(envPath) || existsSync(setupPath)) usage("Refusing to replace existing self-hosted secrets. Use a new directory or inspect the existing deployment.");
const dataPath = resolve("data");
const backupPath = resolve(dataPath, "backups");
mkdirSync(backupPath, { recursive: true, mode: 0o700 });
chmodSync(dataPath, 0o700);
chmodSync(backupPath, 0o700);

const setupToken = randomBytes(32).toString("base64url");
const setupExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
const values = [
  `DJMIMA_PUBLIC_ORIGIN=${origin.origin}`,
  "DJMIMA_TRUST_PROXY=1",
  "DJMIMA_DATABASE_PATH=/app/data/djmima.sqlite",
  "DJMIMA_BACKUP_DIR=/app/data/backups",
  `PRIMARY_ADMIN_ACCOUNT=${account}`,
  `VAULT_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`,
  `VAULT_AUDIT_SIGNING_KEY=${randomBytes(32).toString("base64url")}`,
  `AUTH_TOTP_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`,
  `LOGIN_TOKEN_HASH_KEY=${randomBytes(32).toString("base64url")}`,
  // Production blocks login when the local country database or security mail
  // service is unavailable. Configure both before the first login.
  "DJMIMA_GEOIP_DATABASE_PATH=/app/data/GeoLite2-City.mmdb",
  `PRIMARY_ADMIN_TOTP_SECRET=${base32()}`,
  `SELFHOST_SETUP_TOKEN=${setupToken}`,
  `SELFHOST_SETUP_EXPIRES_AT=${setupExpiresAt}`,
].join("\n");

writeFileSync(envPath, `${values}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
writeFileSync(setupPath, `${origin.origin}/setup#token=${setupToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
chmodSync(envPath, 0o600);
chmodSync(setupPath, 0o600);
console.log("Created server-only .env and a one-time initial setup address.");
