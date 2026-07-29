import { isIP } from "node:net";

/**
 * Reads a client address only for short-lived abuse limiting and local GeoIP
 * lookup. It is never used as a login allowlist or persisted as an address.
 */
export function requestClientIp(request: Request) {
  if (process.env.DJMIMA_TRUST_PROXY === "1") {
    const value = request.headers.get("x-real-ip")?.trim() ?? "";
    if (isIP(value)) return value;
  }

  const hostname = new URL(request.url).hostname;
  if (process.env.NODE_ENV !== "production" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) {
    return "127.0.0.1";
  }
  return null;
}
