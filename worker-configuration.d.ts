declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    PRIMARY_ADMIN_EMAIL?: string;
    VAULT_ENCRYPTION_KEY?: string;
    VAULT_ACTIVE_ENCRYPTION_KEY?: string;
    VAULT_ENCRYPTION_KEYS?: string;
    VAULT_ACTIVE_KEY_ID?: string;
    VAULT_AUDIT_SIGNING_KEY?: string;
    VAULT_AUDIT_SIGNING_KEYS?: string;
    VAULT_ACTIVE_AUDIT_SIGNING_KEY_ID?: string;
    BACKUP_WORKER_PUBLIC_KEY?: string;
  }
}
