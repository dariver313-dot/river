export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export type TotpConfig = {
  secret: string;
  issuer?: string;
  accountName?: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: number;
};

const MIN_SECRET_LENGTH = 16;

function cleanDisplayValue(value: string | null | undefined) {
  const cleaned = value?.trim().slice(0, 120);
  return cleaned || undefined;
}

function normalizeSecret(value: string) {
  const secret = value.trim().toUpperCase().replace(/[\s-]/g, "").replace(/=+$/g, "");
  if (!/^[A-Z2-7]+$/.test(secret) || secret.length < MIN_SECRET_LENGTH || secret.length > 512) {
    throw new Error("请输入有效的验证器 Setup Key，或粘贴完整二维码内容。");
  }
  return secret;
}

function normalizeAlgorithm(value: unknown): TotpAlgorithm {
  const algorithm = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "SHA1";
  if (algorithm === "SHA256") return "SHA-256";
  if (algorithm === "SHA512") return "SHA-512";
  if (algorithm === "SHA1") return "SHA-1";
  throw new Error("该验证器使用了不受支持的算法。");
}

function normalizeDigits(value: unknown): 6 | 8 {
  const digits = typeof value === "number" ? value : Number.parseInt(String(value ?? "6"), 10);
  if (digits === 6 || digits === 8) return digits;
  throw new Error("仅支持 6 位或 8 位验证器代码。");
}

function normalizePeriod(value: unknown) {
  const period = typeof value === "number" ? value : Number.parseInt(String(value ?? "30"), 10);
  if (!Number.isInteger(period) || period < 15 || period > 120) {
    throw new Error("验证器的刷新周期无效。");
  }
  return period;
}

function fromParts(parts: {
  secret: string;
  issuer?: string | null;
  accountName?: string | null;
  algorithm?: unknown;
  digits?: unknown;
  period?: unknown;
}): TotpConfig {
  return {
    secret: normalizeSecret(parts.secret),
    ...(cleanDisplayValue(parts.issuer) ? { issuer: cleanDisplayValue(parts.issuer) } : {}),
    ...(cleanDisplayValue(parts.accountName) ? { accountName: cleanDisplayValue(parts.accountName) } : {}),
    algorithm: normalizeAlgorithm(parts.algorithm),
    digits: normalizeDigits(parts.digits),
    period: normalizePeriod(parts.period),
  };
}

export function parseTotpInput(input: string): TotpConfig {
  const raw = input.trim();
  if (!raw) throw new Error("请输入验证器 Setup Key，或粘贴二维码内容。");

  if (!raw.toLowerCase().startsWith("otpauth://")) {
    return fromParts({ secret: raw });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("二维码内容不是有效的验证器配置。");
  }

  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") {
    throw new Error("仅支持基于时间的一次性验证码（TOTP）。");
  }

  let label = "";
  try {
    label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("二维码中的账号标签无效。");
  }
  const separator = label.indexOf(":");
  const labelIssuer = separator >= 0 ? label.slice(0, separator) : undefined;
  const accountName = separator >= 0 ? label.slice(separator + 1) : label || undefined;

  return fromParts({
    secret: url.searchParams.get("secret") ?? "",
    issuer: url.searchParams.get("issuer") ?? labelIssuer,
    accountName,
    algorithm: url.searchParams.get("algorithm") ?? undefined,
    digits: url.searchParams.get("digits") ?? undefined,
    period: url.searchParams.get("period") ?? undefined,
  });
}

export function toTotpConfig(value: unknown): TotpConfig | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return parseTotpInput(value);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("验证器配置无效。");
  }

  const source = value as Record<string, unknown>;
  if (typeof source.secret !== "string") throw new Error("验证器配置缺少 Setup Key。");
  return fromParts({
    secret: source.secret,
    issuer: typeof source.issuer === "string" ? source.issuer : undefined,
    accountName: typeof source.accountName === "string" ? source.accountName : undefined,
    algorithm: source.algorithm,
    digits: source.digits,
    period: source.period,
  });
}

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("验证器 Setup Key 无效。");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

export async function generateTotpCode(config: TotpConfig, now = Date.now()) {
  const counter = BigInt(Math.floor(now / 1_000 / config.period));
  const counterBytes = new Uint8Array(8);
  let remaining = counter;
  for (let index = counterBytes.length - 1; index >= 0; index -= 1) {
    counterBytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(config.secret),
    { name: "HMAC", hash: config.algorithm },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = signature[signature.length - 1] & 0x0f;
  const numericCode = ((signature[offset] & 0x7f) * 0x1000000)
    + (signature[offset + 1] << 16)
    + (signature[offset + 2] << 8)
    + signature[offset + 3];

  return String(numericCode % (10 ** config.digits)).padStart(config.digits, "0");
}

export function totpSecondsRemaining(config: TotpConfig, now = Date.now()) {
  const secondsElapsed = Math.floor(now / 1_000) % config.period;
  return config.period - secondsElapsed;
}

export function totpLabel(config: TotpConfig) {
  return config.issuer ?? config.accountName ?? "验证器代码";
}
