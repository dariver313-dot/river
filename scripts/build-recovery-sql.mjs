import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/build-recovery-sql.mjs <encrypted-backup.json> <output.sql>");
}

const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
if (snapshot?.format !== "djmima-encrypted-logical-backup/v1" || !snapshot.tables || typeof snapshot.tables !== "object") {
  throw new Error("The input is not a supported djmima encrypted backup.");
}

const tableColumns = {
  app_settings: ["key", "value", "updated_at"],
  app_users: ["email", "role", "status", "created_by", "created_at", "updated_at"],
  vaults: ["id", "owner_email", "kind", "name", "created_at", "updated_at"],
  vault_members: ["id", "vault_id", "email", "role", "created_at"],
  vault_items: ["id", "vault_id", "ciphertext", "iv", "created_at", "updated_at", "key_id", "encryption_version"],
  audit_events: ["id", "vault_id", "actor_email", "action", "item_id", "created_at", "signature", "signature_key_id", "event_version", "sequence", "previous_hash", "chain_hash"],
  audit_chain_states: ["vault_id", "last_sequence", "head_hash", "updated_at"],
};

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Backup includes a non-finite numeric value.");
    return String(value);
  }
  if (typeof value !== "string") throw new Error("Backup includes an unsupported value type.");
  return `'${value.replaceAll("'", "''")}'`;
}

const statements = ["PRAGMA foreign_keys = OFF;", "BEGIN IMMEDIATE;"];
for (const table of Object.keys(tableColumns).toReversed()) statements.push(`DELETE FROM ${table};`);
for (const [table, columns] of Object.entries(tableColumns)) {
  const rows = snapshot.tables[table];
  if (!Array.isArray(rows)) throw new Error(`Backup table ${table} is missing.`);
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Backup table ${table} includes an invalid row.`);
    statements.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => quote(row[column])).join(", ")});`);
  }
}
statements.push("COMMIT;", "PRAGMA foreign_keys = ON;");
await writeFile(outputPath, `${statements.join("\n")}\n`, "utf8");
