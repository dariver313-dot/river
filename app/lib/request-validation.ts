import { ClientSafeError } from "./security-errors.ts";

export const maxJsonRequestBytes = 64 * 1024;

export async function readLimitedJsonObject(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxJsonRequestBytes) {
    throw new ClientSafeError("请求内容过大，请减少后重试。", 413, "REQUEST_TOO_LARGE");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxJsonRequestBytes) {
    throw new ClientSafeError("请求内容过大，请减少后重试。", 413, "REQUEST_TOO_LARGE");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ClientSafeError("请求内容无效。请刷新页面后重试。", 400, "INVALID_JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ClientSafeError("请求内容无效。", 400, "INVALID_JSON_OBJECT");
  }
  return payload as Record<string, unknown>;
}
