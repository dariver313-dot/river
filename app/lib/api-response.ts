import { getAuthenticatedUser } from "../selfhost-session";
import { ensureApplicationUser } from "./user-store";
import { readLimitedJsonObject } from "./request-validation";
import { secureJson } from "./response-security";
import { ClientSafeError } from "./security-errors";
import { requireActiveSecuritySession } from "./security-session";

export async function requireApplicationActor() {
  const user = await getAuthenticatedUser();
  if (!user) return null;
  const account = await ensureApplicationUser(user.email);
  if (!account) return null;
  return { ...account, displayName: user.displayName };
}

export async function requireVaultActor(request?: Request) {
  const actor = await requireApplicationActor();
  if (!actor) return null;
  if (!request) return actor;
  try {
    await requireActiveSecuritySession(actor.email, request);
    return actor;
  } catch {
    return null;
  }
}

export function actorRequiredResponse() {
  return secureJson({ error: "安全会话已结束或系统账户不可用。请重新登录后继续。", code: "SECURITY_SESSION_REQUIRED" }, { status: 401 });
}

export function adminRequiredResponse() {
  return secureJson({ error: "只有管理员可以执行此操作。" }, { status: 403 });
}

export function apiError(error: unknown, status = 500, request?: Request) {
  const requestId = crypto.randomUUID();
  const internalMessage = error instanceof Error ? error.message : String(error);
  // 绝不记录请求体，避免把密码、TOTP 秘钥或导出内容写入日志。
  console.error("djmima_api_error", { requestId, path: request ? new URL(request.url).pathname : "unknown", status, message: internalMessage });

  if (error instanceof ClientSafeError) {
    return secureJson({ error: error.message, code: error.code, requestId }, { status: error.status });
  }

  const message = status >= 500
    ? "服务器暂时无法完成该操作。请稍后重试。"
    : "请求未完成。请检查输入或刷新页面后重试。";
  return secureJson({ error: message, requestId }, { status });
}

export async function readJsonObject(request: Request) {
  return readLimitedJsonObject(request);
}
