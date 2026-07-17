import { getChatGPTUser } from "../chatgpt-auth";

export async function requireVaultActor() {
  const user = await getChatGPTUser();
  if (!user) return null;
  return { email: user.email.toLowerCase(), displayName: user.displayName };
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
