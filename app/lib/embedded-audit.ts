import { getDatabase } from "../../db";
import { canonicalPublicVaultId } from "./shared-public-vault";

/** Shared system audit vault for user, access and embedded-page administration. */
export async function sharedAuditVaultId(actorEmail: string) {
  const database = getDatabase();
  const sharedVault = await database.prepare(
    "SELECT value FROM app_settings WHERE key = 'shared_public_vault' LIMIT 1",
  ).first<{ value: string }>();
  if (sharedVault?.value) return sharedVault.value;

  const existing = await database.prepare(
    "SELECT id FROM vaults WHERE kind = 'public' ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string }>();
  const vaultId = existing?.id ?? canonicalPublicVaultId;
  if (!existing) {
    await database.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_email, kind, name) VALUES (?, ?, 'public', '公共工作区')",
    ).bind(vaultId, actorEmail).run();
  }
  await database.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('shared_public_vault', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(vaultId).run();
  return vaultId;
}

/** Backward-compatible name used by the embedded-page module. */
export const embeddedAuditVaultId = sharedAuditVaultId;
