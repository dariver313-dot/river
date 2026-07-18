export const maxJsonRequestBytes = 64 * 1024;

export async function readLimitedJsonObject(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxJsonRequestBytes) {
    throw new Error("请求内容过大，请减少后重试。");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxJsonRequestBytes) {
    throw new Error("请求内容过大，请减少后重试。");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("请求内容无效。请刷新页面后重试。");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("请求内容无效。");
  }
  return payload as Record<string, unknown>;
}
