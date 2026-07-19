import { env } from "cloudflare:workers";

type VaultRuntimeEnv = {
  VAULT_ENCRYPTION_KEY?: string;
  VAULT_ACTIVE_ENCRYPTION_KEY?: string;
  VAULT_ENCRYPTION_KEYS?: string;
  VAULT_ACTIVE_KEY_ID?: string;
  VAULT_AUDIT_SIGNING_KEY?: string;
  VAULT_AUDIT_SIGNING_KEYS?: string;
  VAULT_ACTIVE_AUDIT_SIGNING_KEY_ID?: string;
};

export type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  keyId?: string | null;
  encryptionVersion?: number | null;
};

export type VaultEncryptionContext = {
  vaultId: string;
  itemId: string;
};

export type AuditSignatureInput = {
  id: string;
  vaultId: string;
  actorEmail: string;
  action: string;
  itemId: string | null;
  createdAt: string;
  sequence: number;
  previousHash: string;
};

type Keyring = {
  activeKeyId: string;
  keys: Record<string, string>;
};

let encryptionKeyringPromise: Promise<Keyring> | null = null;
const encryptionKeyPromises = new Map<string, Promise<CryptoKey>>();
let auditKeyringPromise: Promise<Keyring> | null = null;
const auditKeyPromises = new Map<string, Promise<CryptoKey>>();

function toBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validKeyId(value: string) {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function parseKeyring(value: string | undefined, fallback: string | undefined, activeSecret: string | undefined, activeOverride: string | undefined, defaultKeyId: string): Keyring {
  if (value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Vault keyring is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Vault keyring must be an object.");
    const keys = Object.fromEntries(Object.entries(parsed).filter(([key, secret]) => validKeyId(key) && typeof secret === "string" && secret.length > 0));
    if (Object.keys(keys).length === 0) throw new Error("Vault keyring has no usable keys.");
    const activeKeyId = activeOverride || (keys.legacy ? "legacy" : Object.keys(keys)[0]);
    if (!keys[activeKeyId]) throw new Error("Vault active key is not present in the keyring.");
    return { activeKeyId, keys };
  }

  if (!fallback) throw new Error("Vault encryption is not configured.");
  const activeKeyId = activeOverride || defaultKeyId;
  // 单密钥部署仍兼容历史 legacy 行，同时允许先把新写入标记到指定 key id。
  return { activeKeyId, keys: { legacy: fallback, [activeKeyId]: activeSecret || fallback } };
}

function encryptionKeyring() {
  if (!encryptionKeyringPromise) {
    encryptionKeyringPromise = Promise.resolve().then(() => {
      const runtime = env as unknown as VaultRuntimeEnv;
      return parseKeyring(runtime.VAULT_ENCRYPTION_KEYS, runtime.VAULT_ENCRYPTION_KEY, runtime.VAULT_ACTIVE_ENCRYPTION_KEY, runtime.VAULT_ACTIVE_KEY_ID, "legacy");
    });
  }
  return encryptionKeyringPromise;
}

async function encryptionKeyMaterial(keyId: string) {
  const keyring = await encryptionKeyring();
  const secret = keyring.keys[keyId];
  if (!secret) throw new Error("Vault item refers to an unavailable encryption key.");
  const keyMaterial = toBytes(secret);
  if (keyMaterial.byteLength !== 32) throw new Error("Vault encryption key must be 32 bytes.");
  return keyMaterial;
}

function getEncryptionKey(keyId: string) {
  let keyPromise = encryptionKeyPromises.get(keyId);
  if (!keyPromise) {
    keyPromise = encryptionKeyMaterial(keyId).then((keyMaterial) => crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
    encryptionKeyPromises.set(keyId, keyPromise);
  }
  return keyPromise;
}

async function auditKeyring() {
  if (!auditKeyringPromise) {
    auditKeyringPromise = (async () => {
      const runtime = env as unknown as VaultRuntimeEnv;
      if (runtime.VAULT_AUDIT_SIGNING_KEYS || runtime.VAULT_AUDIT_SIGNING_KEY) {
        return parseKeyring(
          runtime.VAULT_AUDIT_SIGNING_KEYS,
          runtime.VAULT_AUDIT_SIGNING_KEY,
          undefined,
          runtime.VAULT_ACTIVE_AUDIT_SIGNING_KEY_ID,
          "audit-v1",
        );
      }

      const encryption = await encryptionKeyring();
      return {
        activeKeyId: `derived-${encryption.activeKeyId}`,
        keys: Object.fromEntries(Object.entries(encryption.keys).map(([id, secret]) => [`derived-${id}`, secret])),
      };
    })();
  }
  return auditKeyringPromise;
}

function getAuditKey(keyId: string) {
  let keyPromise = auditKeyPromises.get(keyId);
  if (!keyPromise) {
    keyPromise = auditKeyring().then((keyring) => {
      const secret = keyring.keys[keyId];
      if (!secret) throw new Error("Audit event refers to an unavailable signing key.");
      const material = toBytes(secret);
      if (material.byteLength !== 32) throw new Error("Audit signing key must be 32 bytes.");
      return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    });
    auditKeyPromises.set(keyId, keyPromise);
  }
  return keyPromise;
}

export function vaultAssociatedData(context: VaultEncryptionContext) {
  return `djmima:v2:${context.vaultId}:${context.itemId}`;
}

function auditCanonicalPayload(event: AuditSignatureInput) {
  return JSON.stringify({
    version: 1,
    id: event.id,
    vaultId: event.vaultId,
    actorEmail: event.actorEmail,
    action: event.action,
    itemId: event.itemId,
    createdAt: event.createdAt,
    sequence: event.sequence,
    previousHash: event.previousHash,
  });
}

export async function assertVaultEncryptionReady() {
  try {
    const keyring = await encryptionKeyring();
    await getEncryptionKey(keyring.activeKeyId);
    const audit = await auditKeyring();
    await getAuditKey(audit.activeKeyId);
  } catch {
    throw new Error("密码库加密配置无效。请联系系统管理员检查密钥变量。");
  }
}

export async function activeVaultEncryptionKeyId() {
  return (await encryptionKeyring()).activeKeyId;
}

export async function encryptVaultPayload(payload: unknown, context: VaultEncryptionContext): Promise<Required<EncryptedPayload>> {
  const keyring = await encryptionKeyring();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const source = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(vaultAssociatedData(context)) },
    await getEncryptionKey(keyring.activeKeyId),
    source,
  );

  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv), keyId: keyring.activeKeyId, encryptionVersion: 2 };
}

export async function decryptVaultPayload<T>(payload: EncryptedPayload, context: VaultEncryptionContext): Promise<T> {
  const encryptionVersion = payload.encryptionVersion ?? 1;
  const keyId = payload.keyId || "legacy";
  const algorithm: AesGcmParams = encryptionVersion >= 2
    ? { name: "AES-GCM", iv: toBytes(payload.iv), additionalData: new TextEncoder().encode(vaultAssociatedData(context)) }
    : { name: "AES-GCM", iv: toBytes(payload.iv) };
  const decrypted = await crypto.subtle.decrypt(algorithm, await getEncryptionKey(keyId), toBytes(payload.ciphertext));
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function signAuditEvent(event: AuditSignatureInput) {
  const keyring = await auditKeyring();
  const signature = await crypto.subtle.sign("HMAC", await getAuditKey(keyring.activeKeyId), new TextEncoder().encode(auditCanonicalPayload(event)));
  return { signature: toBase64(new Uint8Array(signature)), signatureKeyId: keyring.activeKeyId, eventVersion: 1 };
}

export async function verifyAuditEvent(event: AuditSignatureInput & { signature: string | null; signatureKeyId: string | null; eventVersion: number }) {
  if (event.eventVersion !== 1 || !event.signature || !event.signatureKeyId) return "legacy" as const;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await getAuditKey(event.signatureKeyId),
      toBytes(event.signature),
      new TextEncoder().encode(auditCanonicalPayload(event)),
    );
    return valid ? "sealed" as const : "failed" as const;
  } catch {
    return "failed" as const;
  }
}
