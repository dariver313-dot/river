import { randomBytes } from "node:crypto";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base64Url(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
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

console.log("# Copy these values into the server-only .env file once. Do not reuse them.");
console.log(`VAULT_ENCRYPTION_KEY=${base64Url()}`);
console.log(`VAULT_AUDIT_SIGNING_KEY=${base64Url()}`);
console.log(`AUTH_TOTP_ENCRYPTION_KEY=${base64Url()}`);
console.log(`PRIMARY_ADMIN_TOTP_SECRET=${base32()}`);
console.log(`APPROVER_TOTP_SECRET=${base32()}`);
