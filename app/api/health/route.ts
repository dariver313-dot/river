import { getDatabase } from "../../../db";
import { assertAuthTotpEncryptionReady } from "../../lib/auth-totp-crypto";
import { secureJson } from "../../lib/response-security";
import { assertVaultEncryptionReady } from "../../lib/vault-crypto";
import { runtimeReadinessIssues } from "../../lib/runtime-readiness";

export const dynamic = "force-dynamic";

async function checkHealthRequirement(name: string, check: () => Promise<unknown>) {
  try {
    await check();
    return null;
  } catch {
    return name;
  }
}

export async function GET(request: Request) {
  const livenessOnly = new URL(request.url).searchParams.get("mode") === "live";
  const [authTotpIssue, vaultIssue, databaseIssue, runtimeIssues] = await Promise.all([
    checkHealthRequirement("AUTH_TOTP_ENCRYPTION_UNAVAILABLE", () => assertAuthTotpEncryptionReady()),
    checkHealthRequirement("VAULT_ENCRYPTION_UNAVAILABLE", () => assertVaultEncryptionReady()),
    checkHealthRequirement("DATABASE_UNAVAILABLE", () => getDatabase().prepare("SELECT 1 AS healthy").bind().first<{ healthy: number }>()),
    livenessOnly
      ? Promise.resolve([] as string[])
      : runtimeReadinessIssues().catch(() => ["RUNTIME_CONFIGURATION_UNAVAILABLE"]),
  ]);
  const issues = [authTotpIssue, vaultIssue, databaseIssue, ...runtimeIssues].filter((issue): issue is string => Boolean(issue));
  if (issues.length) {
    console.error("djmima_health_check_failed", { issues });
    return secureJson({ status: "unavailable", issues }, { status: 503 });
  }
  return secureJson({ status: "ok" });
}
