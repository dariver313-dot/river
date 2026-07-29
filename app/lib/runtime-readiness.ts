import { isValidLoginAccount, normalizeLoginAccount } from "./identity";
import { parseTotpInput } from "./totp";
import { geoIpReady } from "./local-geoip";
import { loginRiskMode } from "./login-risk";
import { securityEmailReady } from "./security-email";
import { getDatabase } from "../../db";

/**
 * Checks deployment prerequisites without returning their secret values.  This
 * is intentionally separate from liveness: a reachable database alone is not
 * enough for a vault that must authenticate every user with an authenticator
 * and verify country-change mail challenges in production.
 */
export async function runtimeReadinessIssues() {
  const issues: string[] = [];
  const account = normalizeLoginAccount(process.env.PRIMARY_ADMIN_ACCOUNT ?? process.env.PRIMARY_ADMIN_EMAIL ?? "");
  if (!isValidLoginAccount(account)) issues.push("PRIMARY_ADMIN_ACCOUNT_INVALID");

  const tokenHashKey = process.env.LOGIN_TOKEN_HASH_KEY?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(tokenHashKey) || Buffer.from(tokenHashKey, "base64url").byteLength !== 32) {
    issues.push("LOGIN_TOKEN_HASH_KEY_INVALID");
  }

  const totpSecret = process.env.PRIMARY_ADMIN_TOTP_SECRET?.trim();
  if (!totpSecret) {
    issues.push("PRIMARY_ADMIN_TOTP_SECRET_MISSING");
  } else {
    try {
      if (parseTotpInput(totpSecret).digits !== 6) issues.push("PRIMARY_ADMIN_TOTP_SECRET_INVALID");
    } catch {
      issues.push("PRIMARY_ADMIN_TOTP_SECRET_INVALID");
    }
  }

  if (process.env.NODE_ENV === "production" && process.env.DJMIMA_TRUST_PROXY !== "1") {
    issues.push("TRUSTED_PROXY_NOT_CONFIGURED");
  }

  if (isValidLoginAccount(account)) {
    try {
      const administrator = await getDatabase().prepare(
        "SELECT status, auth_totp_secret, security_email, security_email_verified_at FROM app_users WHERE email = ? AND role = 'admin' LIMIT 1",
      ).bind(account).first<{
        status: string;
        auth_totp_secret: string | null;
        security_email: string | null;
        security_email_verified_at: string | null;
      }>();
      if (!administrator || administrator.status !== "active" || !administrator.auth_totp_secret) {
        issues.push("INITIAL_ADMIN_NOT_INITIALIZED");
      }
      if (!administrator?.security_email || !administrator.security_email_verified_at) {
        issues.push("INITIAL_ADMIN_SECURITY_EMAIL_UNVERIFIED");
      }
    } catch {
      issues.push("DATABASE_UNAVAILABLE");
    }
  }

  if (loginRiskMode() === "enforce") {
    const [geoIpAvailable, securityEmailAvailable] = await Promise.all([geoIpReady(), securityEmailReady()]);
    if (!geoIpAvailable) issues.push("GEOIP_DATABASE_UNAVAILABLE");
    if (!securityEmailAvailable) issues.push("SECURITY_EMAIL_UNAVAILABLE");
  }
  return issues;
}

export async function assertRuntimeReady() {
  const issues = await runtimeReadinessIssues();
  if (issues.length) throw new Error(`runtime readiness failed: ${issues.join(",")}`);
}
