import crypto from 'crypto';

/** Base32 解码（RFC 4648，兼容 Google Authenticator 格式） */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');

  const bits: number[] = [];
  for (const char of cleaned) {
    const val = alphabet.indexOf(char);
    if (val < 0) {
      throw new Error(`Invalid base32 character: '${char}' (code ${char.codePointAt(0)?.toString(16)}). Check your TOTP secret — only A-Z and 2-7 are allowed.`);
    }
    bits.push((val >> 4) & 1, (val >> 3) & 1, (val >> 2) & 1, (val >> 1) & 1, val & 1);
  }

  const bytes: number[] = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    bytes.push(
      (bits[i] << 7) | (bits[i + 1] << 6) | (bits[i + 2] << 5) | (bits[i + 3] << 4) |
      (bits[i + 4] << 3) | (bits[i + 5] << 2) | (bits[i + 6] << 1) | bits[i + 7]
    );
  }

  return Buffer.from(bytes);
}

function counterToBytes(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  // RFC 6238: counter 为8字节大端整数
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

function dynamicTruncate(hmac: Buffer): number {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return binary % 1_000_000;
}

/**
 * 生成 TOTP 6位数字码（零外部依赖，纯 Node.js crypto）
 * 符合 RFC 6238 / RFC 4226 标准
 */
export function generateTOTP(
  secret: string,
  windowSec: number = 30,
  algorithm: string = 'sha1',
): string {
  const decoded = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / windowSec);
  const counterBytes = counterToBytes(counter);
  const hmac = crypto.createHmac(algorithm, decoded).update(counterBytes).digest();
  const otp = dynamicTruncate(hmac);
  return otp.toString().padStart(6, '0');
}
