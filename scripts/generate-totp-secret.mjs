import { randomBytes } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const bytes = randomBytes(20);
let buffer = 0;
let bits = 0;
let secret = "";

for (const byte of bytes) {
  buffer = (buffer << 8) | byte;
  bits += 8;
  while (bits >= 5) {
    secret += alphabet[(buffer >>> (bits - 5)) & 31];
    bits -= 5;
  }
}
if (bits > 0) secret += alphabet[(buffer << (5 - bits)) & 31];

console.log("# Store this only in the server-side .env file. Do not send it through chat or commit it.");
console.log(`PRIMARY_ADMIN_TOTP_SECRET=${secret}`);
