declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    PRIMARY_ADMIN_EMAIL?: string;
    VAULT_ENCRYPTION_KEY?: string;
  }
}
