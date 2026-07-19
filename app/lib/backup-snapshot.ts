import { getD1 } from "../../db";

type SnapshotRow = Record<string, unknown>;

const encryptedBackupTables = [
  "app_settings",
  "app_users",
  "vaults",
  "vault_members",
  "vault_items",
  "audit_events",
  "audit_chain_states",
] as const;

export type EncryptedBackupSnapshot = {
  format: "djmima-encrypted-logical-backup/v1";
  createdAt: string;
  tables: Record<(typeof encryptedBackupTables)[number], SnapshotRow[]>;
  excludedTables: string[];
};

/**
 * 返回 D1 中的密文与恢复所需元数据；不调用解密逻辑，也不返回安全会话、限流
 * 计数或尚未完成的导出批准，避免恢复后继承临时授权。
 */
export async function createEncryptedBackupSnapshot(): Promise<EncryptedBackupSnapshot> {
  const d1 = getD1();
  const statements = encryptedBackupTables.map((table) => d1.prepare(`SELECT * FROM ${table}`));
  const results = await d1.batch(statements);

  const tables = Object.fromEntries(
    encryptedBackupTables.map((table, index) => [table, (results[index]?.results ?? []) as SnapshotRow[]]),
  ) as EncryptedBackupSnapshot["tables"];

  return {
    format: "djmima-encrypted-logical-backup/v1",
    createdAt: new Date().toISOString(),
    tables,
    excludedTables: ["approval_requests", "security_sessions", "request_rate_limits"],
  };
}
