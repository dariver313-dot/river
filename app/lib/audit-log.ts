import { getD1 } from "../../db";
import { signAuditEvent, verifyAuditEvent } from "./vault-crypto";

const genesisHash = "djmima-audit-chain-v1";

export type StoredAuditEvent = {
  id: string;
  vaultId: string;
  actorEmail: string;
  action: string;
  itemId: string | null;
  createdAt: string;
  signature: string | null;
  signatureKeyId: string | null;
  eventVersion: number;
  sequence: number | null;
  previousHash: string | null;
  chainHash: string | null;
};

type ChainState = {
  last_sequence: number;
  head_hash: string;
};

function toBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function chainHash(event: { id: string; sequence: number; previousHash: string; signature: string }) {
  const source = JSON.stringify({
    version: 1,
    id: event.id,
    sequence: event.sequence,
    previousHash: event.previousHash,
    signature: event.signature,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return toBase64(new Uint8Array(digest));
}

export async function writeAuditEvent(vaultId: string, actorEmail: string, action: string, itemId?: string | null) {
  const d1 = getD1();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await d1.prepare(
      "INSERT OR IGNORE INTO audit_chain_states (vault_id, last_sequence, head_hash) VALUES (?, 0, ?)",
    ).bind(vaultId, genesisHash).run();
    const state = await d1.prepare(
      "SELECT last_sequence, head_hash FROM audit_chain_states WHERE vault_id = ? LIMIT 1",
    ).bind(vaultId).first<ChainState>();
    if (!state) throw new Error("无法初始化审计链。");

    const event = {
      id: crypto.randomUUID(),
      vaultId,
      actorEmail,
      action,
      itemId: itemId ?? null,
      createdAt: new Date().toISOString(),
      sequence: state.last_sequence + 1,
      previousHash: state.head_hash,
    };
    const signature = await signAuditEvent(event);
    const nextHash = await chainHash({
      id: event.id,
      sequence: event.sequence,
      previousHash: event.previousHash,
      signature: signature.signature,
    });

    // 条件插入和状态推进处在同一个 D1 batch 内。若另一请求先写入，两个语句都不会改变状态，随后重试。
    const result = await d1.batch([
      d1.prepare(
        `INSERT INTO audit_events (
          id, vault_id, actor_email, action, item_id, created_at, signature, signature_key_id, event_version, sequence, previous_hash, chain_hash
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_chain_states WHERE vault_id = ? AND last_sequence = ? AND head_hash = ?)`,
      ).bind(
        event.id,
        event.vaultId,
        event.actorEmail,
        event.action,
        event.itemId,
        event.createdAt,
        signature.signature,
        signature.signatureKeyId,
        signature.eventVersion,
        event.sequence,
        event.previousHash,
        nextHash,
        event.vaultId,
        state.last_sequence,
        state.head_hash,
      ),
      d1.prepare(
        `UPDATE audit_chain_states
         SET last_sequence = ?, head_hash = ?, updated_at = CURRENT_TIMESTAMP
         WHERE vault_id = ? AND last_sequence = ? AND head_hash = ?
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(event.sequence, nextHash, event.vaultId, state.last_sequence, state.head_hash, event.id),
    ]);
    const inserted = result[0].meta.changes ?? 0;
    const advanced = result[1].meta.changes ?? 0;
    if (inserted === 1 && advanced === 1) return event.id;
    if (inserted > 0) await d1.prepare("DELETE FROM audit_events WHERE id = ?").bind(event.id).run();
  }
  throw new Error("审计链繁忙，操作未被记录。请稍后重试。");
}

export async function auditIntegrity(event: StoredAuditEvent) {
  if (event.eventVersion !== 1) return "legacy" as const;
  if (event.sequence === null || !event.previousHash || !event.chainHash || !event.signature) return "failed" as const;
  const signatureIntegrity = await verifyAuditEvent(event);
  if (signatureIntegrity !== "sealed") return signatureIntegrity;
  const expectedHash = await chainHash({
    id: event.id,
    sequence: event.sequence,
    previousHash: event.previousHash,
    signature: event.signature,
  });
  return expectedHash === event.chainHash ? "sealed" as const : "failed" as const;
}

export async function verifyAuditChain(vaultId: string, events: StoredAuditEvent[]) {
  const sealed = events.filter((event) => event.eventVersion === 1).sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  if (sealed.length === 0) return "legacy" as const;
  const state = await getD1().prepare(
    "SELECT last_sequence, head_hash FROM audit_chain_states WHERE vault_id = ? LIMIT 1",
  ).bind(vaultId).first<ChainState>();
  if (!state) return "failed" as const;

  let previousHash = genesisHash;
  let expectedSequence = 1;
  for (const event of sealed) {
    if (event.sequence !== expectedSequence || event.previousHash !== previousHash || await auditIntegrity(event) !== "sealed") return "failed" as const;
    previousHash = event.chainHash!;
    expectedSequence += 1;
  }
  return state.last_sequence === sealed.length && state.head_hash === previousHash ? "sealed" as const : "failed" as const;
}
