import { getChatGPTUser } from "../chatgpt-auth";
import { ensureApplicationUser } from "./user-store";

export async function requireVaultActor() {
  const user = await getChatGPTUser();
  if (!user) return null;
  const account = await ensureApplicationUser(user.email);
  if (!account) return null;
  return { ...account, displayName: user.displayName };
}

export function actorRequiredResponse() {
  return Response.json({ error: "你的系统账户尚未开通、已停用，或尚未完成安全登录。" }, { status: 403 });
}

export function adminRequiredResponse() {
  return Response.json({ error: "只有管理员可以执行此操作。" }, { status: 403 });
}

export function apiError(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : "服务器暂时无法处理该操作。";
  return Response.json({ error: message }, { status });
}

export async function readJsonObject(request: Request) {
  const payload = await request.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("请求内容无效。");
  }
  return payload as Record<string, unknown>;
}
