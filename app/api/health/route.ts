import { getD1 } from "../../../db";
import { assertAuthTotpEncryptionReady } from "../../lib/auth-totp-crypto";
import { secureJson } from "../../lib/response-security";
import { assertVaultEncryptionReady } from "../../lib/vault-crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await Promise.all([
      assertAuthTotpEncryptionReady(),
      assertVaultEncryptionReady(),
      getD1().prepare("SELECT 1 AS healthy").bind().first<{ healthy: number }>(),
    ]);
    return secureJson({ status: "ok" });
  } catch (error) {
    console.error("djmima_health_check_failed", { message: error instanceof Error ? error.message : String(error) });
    return secureJson({ status: "unavailable" }, { status: 503 });
  }
}
