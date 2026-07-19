import { env } from "cloudflare:workers";

type VaultRuntimeEnv = {
  VAULT_ENCRYPTION_KEY?: string;
};

type EncryptedPayload = {
  ciphertext: string;
  iv: string;
};

let keyPromise: Promise<CryptoKey> | null = null;

function toBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function getEncryptionKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const secret = (env as unknown as VaultRuntimeEnv).VAULT_ENCRYPTION_KEY;
      if (!secret) throw new Error("Vault encryption is not configured.");

      const keyMaterial = toBytes(secret);
      if (keyMaterial.byteLength !== 32) {
        throw new Error("Vault encryption key must be 32 bytes.");
      }

      return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
  }

  return keyPromise;
}

export async function assertVaultEncryptionReady() {
  try {
    await getEncryptionKey();
  } catch {
    throw new Error("密码库加密配置无效。请联系系统管理员检查密钥变量。");
  }
}

export async function encryptVaultPayload(payload: unknown): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const source = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getEncryptionKey(), source);

  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function decryptVaultPayload<T>(payload: EncryptedPayload): Promise<T> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBytes(payload.iv) },
    await getEncryptionKey(),
    toBytes(payload.ciphertext),
  );

  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}
