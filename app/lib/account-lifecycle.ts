import { getDatabase } from "../../db";
import { decryptAuthTotpSecret, encryptAuthTotpSecret } from "./auth-totp-crypto";
import { hashLoginPassword } from "./auth-password";
import { writeAuditedMutation } from "./audit-log";
import { sharedAuditVaultId } from "./embedded-audit";
import { isValidLoginAccount, normalizeLoginAccount } from "./identity";
import { consumePendingAccountTokenStatement, inspectAccountToken, issueAccountToken, issueAdministratorRecoveryCodes, pendingAccountToken } from "./one-time-tokens";
import { securityEmailConfigured, sendPasswordRecoveryCode, sendSecurityEmailChangeCode } from "./security-email";
import { securityEmailConfirmationRequired } from "./security-email-policy";
import { ClientSafeError } from "./security-errors";
import { generateTotpSecret, generateTotpCode, parseTotpInput } from "./totp";
import { isInitialAdminAccount } from "./initial-admin";

type AccountRow = {
  email: string;
  status: "pending" | "active" | "suspended" | "frozen";
  security_email: string | null;
  security_email_verified_at: string | null;
  auth_totp_secret: string | null;
};

type AdminRecoveryStageRow = {
  id: string;
  email: string;
  recovery_token_id: string;
  confirmation_token_id: string;
  password_hash: string;
  auth_totp_secret: string;
  expires_at: string;
  used_at: string | null;
};

type AuthenticatorResetStageRow = {
  id: string;
  email: string;
  confirmation_token_id: string;
  auth_totp_secret: string;
  expires_at: string;
  used_at: string | null;
};

function securityEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function equalCode(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function validTotp(secret: string, suppliedCode: string) {
  if (!/^\d{6}$/.test(suppliedCode)) return false;
  const config = parseTotpInput(secret);
  if (config.digits !== 6) return false;
  const now = Date.now();
  const candidates = await Promise.all([
    generateTotpCode(config, now - config.period * 1_000),
    generateTotpCode(config, now),
    generateTotpCode(config, now + config.period * 1_000),
  ]);
  return candidates.some((candidate) => equalCode(candidate, suppliedCode));
}

async function account(email: string) {
  return getDatabase().prepare(
    "SELECT email, status, security_email, security_email_verified_at, auth_totp_secret FROM app_users WHERE email = ? LIMIT 1",
  ).bind(normalizeLoginAccount(email)).first<AccountRow>();
}

/**
 * Phase one consumes the administrator-issued activation code, establishes the
 * password and creates an encrypted TOTP secret.  The account remains pending
 * until the user proves that their authenticator was actually enrolled.
 */
export async function beginAccountActivation(input: { code: unknown; password: unknown }) {
  const token = await pendingAccountToken({ code: input.code, purpose: "activation" });
  if (!token) return null;
  const row = await account(token.email);
  if (!row || row.status !== "pending") return null;
  const password = typeof input.password === "string" ? input.password : "";
  const passwordHash = await hashLoginPassword(password);
  const setupKey = generateTotpSecret();
  const encryptedTotpSecret = await encryptAuthTotpSecret(row.email, setupKey);
  const database = getDatabase();
  const usedAt = new Date().toISOString();
  // Create the second-stage code before consuming the activation factor. If
  // generating it fails, the user can retry with the original activation code.
  // A failed transaction leaves only an unusable pending confirmation, which a
  // subsequent retry revokes automatically.
  const confirmation = await issueAccountToken({
    email: row.email,
    purpose: "activation_confirm",
    createdBy: row.email,
    lifetimeMs: 15 * 60_000,
  });
  await writeAuditedMutation(await sharedAuditVaultId(row.email), row.email, "system_user_activation_started", row.email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'pending'", values: [row.email] },
    commitPrerequisite: {
      sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'pending' AND password_hash = ? AND auth_totp_secret = ?",
      values: [row.email, passwordHash, encryptedTotpSecret],
    },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token, usedAt, guard }),
      database.prepare(
        `UPDATE app_users
         SET password_hash = ?, auth_totp_secret = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(passwordHash, encryptedTotpSecret, row.email, token.id, usedAt, ...guard.values, guard.auditEventId),
    ],
  });
  return { email: row.email, setupKey, confirmationCode: confirmation.code, expiresAt: confirmation.expiresAt };
}

export async function confirmAccountActivation(input: { code: unknown; userCode: unknown }) {
  const code = typeof input.code === "string" ? input.code : "";
  const candidate = await pendingAccountToken({ code, purpose: "activation_confirm" });
  if (!candidate) return null;
  const row = await account(candidate.email);
  if (!row || row.status !== "pending" || !row.auth_totp_secret) return null;
  const secret = await decryptAuthTotpSecret(row.email, row.auth_totp_secret);
  const userCode = typeof input.userCode === "string" ? input.userCode.trim() : "";
  if (!await validTotp(secret, userCode)) return { confirmed: false as const, error: "Google 验证码不正确，请确认已完成扫码后重试。" };
  const usedAt = new Date().toISOString();
  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(row.email), row.email, "system_user_activated", row.email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'pending'", values: [row.email] },
    commitPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active' AND security_email_verified_at IS NOT NULL", values: [row.email] },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token: candidate, usedAt, guard }),
      database.prepare(
        `UPDATE app_users SET status = 'active', security_email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(row.email, candidate.id, usedAt, ...guard.values, guard.auditEventId),
    ],
  });
  return { confirmed: true as const, email: row.email };
}

/**
 * This flow is started only after an administrator has verified the user's
 * identity and sent an opaque code to the already-verified safety mailbox.
 * The replacement secret remains in a short-lived recovery stage until the
 * user proves it, so an expired confirmation cannot accidentally become a
 * usable login factor.
 */
export async function beginAuthenticatorReset(input: { code: unknown }) {
  const token = await pendingAccountToken({ code: input.code, purpose: "authenticator_reset" });
  if (!token) return null;
  const row = await account(token.email);
  if (!row || row.status !== "active" || row.auth_totp_secret) return null;
  const setupKey = generateTotpSecret();
  const encryptedTotpSecret = await encryptAuthTotpSecret(row.email, setupKey);
  const confirmation = await issueAccountToken({
    email: row.email,
    purpose: "authenticator_reset_confirm",
    createdBy: row.email,
    lifetimeMs: 15 * 60_000,
  });
  const database = getDatabase();
  const now = new Date().toISOString();
  await writeAuditedMutation(await sharedAuditVaultId(row.email), row.email, "system_user_authenticator_recovery_started", row.email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active' AND auth_totp_secret IS NULL", values: [row.email] },
    commitPrerequisite: {
      sql: "SELECT 1 FROM authenticator_reset_stages WHERE confirmation_token_id = ? AND email = ? AND used_at IS NULL AND expires_at > ?",
      values: [confirmation.id, row.email, now],
    },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1 && (results[2]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token, usedAt: now, guard }),
      database.prepare(
        `UPDATE authenticator_reset_stages SET used_at = ?
         WHERE email = ? AND used_at IS NULL
           AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, row.email, ...guard.values, guard.auditEventId),
      database.prepare(
        `INSERT INTO authenticator_reset_stages (id, email, confirmation_token_id, auth_totp_secret, expires_at)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND status = 'active' AND auth_totp_secret IS NULL)
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(crypto.randomUUID(), row.email, confirmation.id, encryptedTotpSecret, confirmation.expiresAt, token.id, now, row.email, ...guard.values, guard.auditEventId),
    ],
  });
  return { email: row.email, setupKey, confirmationCode: confirmation.code, expiresAt: confirmation.expiresAt };
}

export async function confirmAuthenticatorReset(input: { code: unknown; userCode: unknown }) {
  const token = await pendingAccountToken({ code: input.code, purpose: "authenticator_reset_confirm" });
  if (!token) return null;
  const stage = await getDatabase().prepare(
    `SELECT id, email, confirmation_token_id, auth_totp_secret, expires_at, used_at
     FROM authenticator_reset_stages WHERE confirmation_token_id = ? LIMIT 1`,
  ).bind(token.id).first<AuthenticatorResetStageRow>();
  if (!stage || stage.used_at || Date.parse(stage.expires_at) <= Date.now()) return null;
  const secret = await decryptAuthTotpSecret(stage.email, stage.auth_totp_secret);
  const userCode = typeof input.userCode === "string" ? input.userCode.trim() : "";
  if (!await validTotp(secret, userCode)) return { confirmed: false as const, error: "Google 验证码不正确，请确认已完成扫码后重试。" };
  const now = new Date().toISOString();
  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(stage.email), stage.email, "system_user_authenticator_recovered", stage.email, {
    auditOrder: "before",
    auditPrerequisite: {
      sql: "SELECT 1 FROM authenticator_reset_stages WHERE id = ? AND used_at IS NULL AND expires_at > ?",
      values: [stage.id, now],
    },
    commitPrerequisite: {
      sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active' AND auth_totp_secret = ?",
      values: [stage.email, stage.auth_totp_secret],
    },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1
      && (results[1]?.meta.changes ?? 0) === 1
      && (results[4]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token, usedAt: now, guard }),
      database.prepare(
        `UPDATE app_users SET auth_totp_secret = ?, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'active' AND auth_totp_secret IS NULL
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(stage.auth_totp_secret, stage.email, ...guard.values, token.id, now, guard.auditEventId),
      database.prepare(
        `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND auth_totp_secret = ?)`,
      ).bind(now, stage.email, ...guard.values, guard.auditEventId, stage.email, stage.auth_totp_secret),
      database.prepare(
        `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND auth_totp_secret = ?)`,
      ).bind(now, stage.email, ...guard.values, guard.auditEventId, stage.email, stage.auth_totp_secret),
      database.prepare(
        `UPDATE authenticator_reset_stages SET used_at = ? WHERE id = ? AND used_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, stage.id, ...guard.values, guard.auditEventId),
    ],
  });
  return { confirmed: true as const, email: stage.email };
}

/** Generic caller response intentionally does not disclose whether an account exists. */
export async function requestPasswordRecovery(input: { account: unknown }) {
  const email = typeof input.account === "string" ? normalizeLoginAccount(input.account) : "";
  // The initial administrator has a deliberately separate, offline
  // break-glass path. Do not turn its mailbox into an alternate recovery
  // factor that could bypass the stored recovery codes.
  if (!isValidLoginAccount(email) || isInitialAdminAccount(email) || !securityEmailConfigured()) return { accepted: true as const };
  const row = await account(email);
  const target = row?.status === "active" && row.security_email_verified_at ? securityEmail(row.security_email) : null;
  if (!target) return { accepted: true as const };
  const token = await issueAccountToken({ email, purpose: "password_recovery", createdBy: email, lifetimeMs: 15 * 60_000 });
  try {
    await sendPasswordRecoveryCode({ to: target, code: token.code, expiresAt: token.expiresAt });
  } catch {
    // The endpoint remains account-enumeration safe; no state indicating the
    // target address is exposed to the caller.
  }
  return { accepted: true as const };
}

export async function completePasswordRecovery(input: { code: unknown; password: unknown }) {
  const token = await pendingAccountToken({ code: input.code, purpose: "password_recovery" });
  if (!token) return null;
  const row = await account(token.email);
  if (!row || row.status !== "active" || !row.security_email_verified_at || isInitialAdminAccount(row.email)) return null;
  const password = typeof input.password === "string" ? input.password : "";
  const passwordHash = await hashLoginPassword(password);
  const now = new Date().toISOString();
  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(row.email), row.email, "account_password_recovered", row.email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active'", values: [row.email] },
    commitPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?", values: [row.email, passwordHash] },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token, usedAt: now, guard }),
      database.prepare(
        `UPDATE app_users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'active' AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(passwordHash, row.email, ...guard.values, token.id, now, guard.auditEventId),
      database.prepare(
        `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?)`,
      ).bind(now, row.email, ...guard.values, guard.auditEventId, row.email, passwordHash),
      database.prepare(
        `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?)`,
      ).bind(now, row.email, ...guard.values, guard.auditEventId, row.email, passwordHash),
      database.prepare(
        `UPDATE login_challenges SET used_at = ? WHERE email = ? AND used_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, row.email, ...guard.values, guard.auditEventId),
    ],
  });
  return { email: row.email };
}

/**
 * A security email is a recovery and country-change factor. The route that
 * starts this change requires a current Google verification for established
 * accounts; the destination mailbox still has to confirm the final change.
 */
export async function requestSecurityEmailChange(input: { account: string; securityEmail: unknown }) {
  const email = normalizeLoginAccount(input.account);
  const target = securityEmail(typeof input.securityEmail === "string" ? input.securityEmail : null);
  if (!isValidLoginAccount(email) || !target) throw new ClientSafeError("请填写有效的安全邮箱。");
  if (!securityEmailConfigured()) throw new ClientSafeError("尚未配置安全邮箱通知服务，暂不能变更安全邮箱。", 503, "SECURITY_EMAIL_UNAVAILABLE");
  const row = await account(email);
  if (!row || row.status !== "active") return null;
  if (!securityEmailConfirmationRequired({
    currentEmail: row.security_email,
    verifiedAt: row.security_email_verified_at,
    targetEmail: target,
  })) return { unchanged: true as const };
  const token = await issueAccountToken({
    email,
    purpose: "security_email_change",
    createdBy: email,
    lifetimeMs: 15 * 60_000,
    targetEmail: target,
  });
  await sendSecurityEmailChangeCode({ to: target, code: token.code, expiresAt: token.expiresAt });
  return { unchanged: false as const, expiresAt: token.expiresAt };
}

export async function confirmSecurityEmailChange(input: { account: string; securityEmail: unknown; code: unknown }) {
  const email = normalizeLoginAccount(input.account);
  const target = securityEmail(typeof input.securityEmail === "string" ? input.securityEmail : null);
  if (!isValidLoginAccount(email) || !target) return null;
  const token = await pendingAccountToken({ code: input.code, purpose: "security_email_change" });
  if (!token || token.email !== email || token.targetEmail !== target) return null;
  const row = await account(email);
  if (!row || row.status !== "active") return null;
  const database = getDatabase();
  const now = new Date().toISOString();
  await writeAuditedMutation(await sharedAuditVaultId(email), email, "account_security_email_changed", email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active'", values: [email] },
    commitPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active' AND security_email = ? AND security_email_verified_at IS NOT NULL", values: [email, target] },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token, usedAt: now, guard }),
      database.prepare(
        `UPDATE app_users SET security_email = ?, security_email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'active' AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(target, email, ...guard.values, token.id, now, guard.auditEventId),
      database.prepare(
        `UPDATE login_challenges SET used_at = ? WHERE email = ? AND used_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, email, ...guard.values, guard.auditEventId),
      database.prepare(
        `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, email, ...guard.values, guard.auditEventId),
      database.prepare(
        `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, email, ...guard.values, guard.auditEventId),
      database.prepare(
        `UPDATE account_tokens SET revoked_at = ?
         WHERE email = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL
           AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, email, token.id, ...guard.values, guard.auditEventId),
    ],
  });
  // The e-mail proof changes who can recover this account. Always issue the
  // next application session only after that proof has been durably recorded.
  return { email, securityEmail: target, requiresRelogin: true };
}

/** Replaces every unused initial-administrator recovery code after fresh TOTP confirmation. */
export async function regenerateAdministratorRecoveryCodes(accountEmail: string) {
  const email = normalizeLoginAccount(accountEmail);
  if (!isInitialAdminAccount(email)) throw new ClientSafeError("只有初始管理员可以轮换离线恢复码。", 403, "INITIAL_ADMIN_REQUIRED");
  const row = await account(email);
  if (!row || row.status !== "active") throw new ClientSafeError("初始管理员账户不可用。", 409, "INITIAL_ADMIN_UNAVAILABLE");
  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(email), email, "initial_admin_recovery_codes_rotated", email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active'", values: [email] },
    commitPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active'", values: [email] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `UPDATE app_users SET updated_at = CURRENT_TIMESTAMP
       WHERE email = ? AND status = 'active' AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(email, ...guard.values, guard.auditEventId)],
  });
  return issueAdministratorRecoveryCodes({ email, createdBy: email });
}

/**
 * Offline administrator codes are high-entropy, one-use break-glass factors.
 * They start a staged replacement of password and TOTP, but do not change the
 * account until the newly enrolled TOTP is proved in the second step.
 */
export async function beginAdministratorRecovery(input: { code: unknown; password: unknown }) {
  const token = await inspectAccountToken({ code: input.code, purpose: "admin_recovery" });
  if (!token || !isInitialAdminAccount(token.email)) return null;
  const row = await account(token.email);
  if (!row || row.status !== "active") return null;
  const password = typeof input.password === "string" ? input.password : "";
  const passwordHash = await hashLoginPassword(password);
  const setupKey = generateTotpSecret();
  const encryptedTotpSecret = await encryptAuthTotpSecret(row.email, setupKey);
  const confirmation = await issueAccountToken({
    email: row.email,
    purpose: "admin_recovery_confirm",
    createdBy: row.email,
    lifetimeMs: 15 * 60_000,
  });
  const now = new Date().toISOString();
  await getDatabase().batch([
    getDatabase().prepare(
      "UPDATE admin_recovery_stages SET used_at = ? WHERE email = ? AND used_at IS NULL",
    ).bind(now, row.email),
    getDatabase().prepare(
      `INSERT INTO admin_recovery_stages (id, email, recovery_token_id, confirmation_token_id, password_hash, auth_totp_secret, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), row.email, token.id, confirmation.id, passwordHash, encryptedTotpSecret, confirmation.expiresAt),
  ]);
  return { email: row.email, setupKey, confirmationCode: confirmation.code, expiresAt: confirmation.expiresAt };
}

export async function confirmAdministratorRecovery(input: { recoveryCode: unknown; confirmationCode: unknown; userCode: unknown }) {
  const recovery = await pendingAccountToken({ code: input.recoveryCode, purpose: "admin_recovery" });
  const confirmation = await pendingAccountToken({ code: input.confirmationCode, purpose: "admin_recovery_confirm" });
  if (!recovery || !confirmation || recovery.email !== confirmation.email || !isInitialAdminAccount(recovery.email)) return null;
  const stage = await getDatabase().prepare(
    `SELECT id, email, recovery_token_id, confirmation_token_id, password_hash, auth_totp_secret, expires_at, used_at
     FROM admin_recovery_stages WHERE recovery_token_id = ? AND confirmation_token_id = ? LIMIT 1`,
  ).bind(recovery.id, confirmation.id).first<AdminRecoveryStageRow>();
  if (!stage || stage.used_at || Date.parse(stage.expires_at) <= Date.now()) return null;
  const secret = await decryptAuthTotpSecret(stage.email, stage.auth_totp_secret);
  const userCode = typeof input.userCode === "string" ? input.userCode.trim() : "";
  if (!await validTotp(secret, userCode)) return { confirmed: false as const, error: "Google 验证码不正确，请确认已完成扫码后重试。" };
  const now = new Date().toISOString();
  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(stage.email), stage.email, "initial_admin_recovered", stage.email, {
    auditOrder: "before",
    auditPrerequisite: {
      sql: "SELECT 1 FROM admin_recovery_stages WHERE id = ? AND used_at IS NULL AND expires_at > ?",
      values: [stage.id, now],
    },
    commitPrerequisite: {
      sql: "SELECT 1 FROM app_users WHERE email = ? AND password_hash = ? AND auth_totp_secret = ?",
      values: [stage.email, stage.password_hash, stage.auth_totp_secret],
    },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1
      && (results[1]?.meta.changes ?? 0) === 1
      && (results[2]?.meta.changes ?? 0) === 1
      && (results[5]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      consumePendingAccountTokenStatement({ token: confirmation, usedAt: now, guard }),
      consumePendingAccountTokenStatement({ token: recovery, usedAt: now, guard }),
      database.prepare(
        `UPDATE app_users SET password_hash = ?, auth_totp_secret = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'active' AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND EXISTS (SELECT 1 FROM account_tokens WHERE id = ? AND used_at = ?)
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(stage.password_hash, stage.auth_totp_secret, stage.email, ...guard.values, confirmation.id, now, recovery.id, now, guard.auditEventId),
      database.prepare(
        `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?)`,
      ).bind(now, stage.email, ...guard.values, guard.auditEventId, stage.email, stage.password_hash),
      database.prepare(
        `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?)`,
      ).bind(now, stage.email, ...guard.values, guard.auditEventId, stage.email, stage.password_hash),
      database.prepare(
        `UPDATE admin_recovery_stages SET used_at = ? WHERE id = ? AND used_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, stage.id, ...guard.values, guard.auditEventId),
    ],
  });
  return { confirmed: true as const, email: stage.email };
}
