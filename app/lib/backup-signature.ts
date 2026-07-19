function fromBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function backupSignaturePayload(method: string, pathname: string, timestamp: string) {
  return new TextEncoder().encode(`${method.toUpperCase()}\n${pathname}\n${timestamp}`);
}

export async function verifyBackupSignature(publicKeyBase64: string, signatureBase64: string, payload: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(fromBase64(publicKeyBase64)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "Ed25519" }, key, toArrayBuffer(fromBase64(signatureBase64)), toArrayBuffer(payload));
}
