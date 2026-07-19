import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ClientSafeError } from "./security-errors";

const hashLength = 64;
const workFactor = 16_384;
const blockSize = 8;
const parallelization = 1;
const maxMemory = 32 * 1024 * 1024;

export function passwordPolicyError(value: string) {
  if (value.length < 14) return "登录密码至少需要 14 位。";
  if (value.length > 512) return "登录密码过长，请控制在 512 位以内。";
  if (/\p{C}/u.test(value)) return "登录密码不能包含控制字符。";
  return null;
}

async function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, hashLength, {
      N: workFactor,
      r: blockSize,
      p: parallelization,
      maxmem: maxMemory,
    }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/** Passwords are never persisted or returned in plaintext. */
export async function hashLoginPassword(password: string) {
  const policyError = passwordPolicyError(password);
  if (policyError) throw new ClientSafeError(policyError);
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  return ["scrypt", workFactor, blockSize, parallelization, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyLoginPassword(password: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [algorithm, encodedWorkFactor, encodedBlockSize, encodedParallelization, saltValue, hashValue, ...extra] = stored.split("$");
  if (algorithm !== "scrypt" || extra.length !== 0 || !saltValue || !hashValue) return false;
  if (Number(encodedWorkFactor) !== workFactor || Number(encodedBlockSize) !== blockSize || Number(encodedParallelization) !== parallelization) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    if (expected.length !== hashLength) return false;
    const derived = await derive(password, Buffer.from(saltValue, "base64url"));
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
