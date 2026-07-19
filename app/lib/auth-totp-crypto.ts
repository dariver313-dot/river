type AuthTotpKey = CryptoKey;

let encryptionKeyPromise: Promise<AuthTotpKey> | null = null;

function fromBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function configuredKey() {
  const value = process.env.AUTH_TOTP_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("AUTH_TOTP_ENCRYPTION_KEY is not configured.");
  const bytes = fromBase64(value);
  if (bytes.byteLength !== 32) throw new Error("AUTH_TOTP_ENCRYPTION_KEY must be 32 bytes.");
  return bytes;
}

function encryptionKey() {
  if (!encryptionKeyPromise) {
    encryptionKeyPromise = crypto.subtle.importKey(
      "raw",
      configuredKey(),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  return encryptionKeyPromise;
}

function associatedData(email: string) {
  return new TextEncoder().encode(`djmima:selfhost:login-totp:${email.toLowerCase()}`);
}

export async function assertAuthTotpEncryptionReady() {
  await encryptionKey();
}

export async function encryptAuthTotpSecret(email: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(email) },
    await encryptionKey(),
    new TextEncoder().encode(secret),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptAuthTotpSecret(email: string, value: string) {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("用户登录验证器配置无效。");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(parts[1]), additionalData: associatedData(email) },
    await encryptionKey(),
    fromBase64(parts[2]),
  );
  return new TextDecoder().decode(decrypted);
}
