function embeddedFrameSources() {
  // The database decides which HTTPS origins administrators can publish. CSP
  // cannot synchronously query SQLite while headers are assembled, so it
  // permits only the HTTPS scheme; page creation remains fail-closed against
  // the database-backed trusted-origin list.
  return "'self' https:";
}

// Keep JSON/API responses aligned with the document CSP during local
// development. Production never includes this development-only directive.
const developmentScriptSource = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const applicationSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src " + embeddedFrameSources(),
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'" + developmentScriptSource,
  "style-src 'self' 'unsafe-inline'",
].join("; ");

export const vaultNoStoreHeaders = {
  "Cache-Control": "no-store, max-age=0, private",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

export function secureHeaders(source?: HeadersInit, options: { noStore?: boolean } = {}) {
  const headers = new Headers(source);
  headers.set("Content-Security-Policy", applicationSecurityPolicy);
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");

  if (options.noStore) {
    for (const [name, value] of Object.entries(vaultNoStoreHeaders)) headers.set(name, value);
  }

  return headers;
}

export function secureJson(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, { ...init, headers: secureHeaders(init.headers, { noStore: true }) });
}

export function secureEmpty(status = 204, headers?: HeadersInit) {
  return new Response(null, { status, headers: secureHeaders(headers, { noStore: true }) });
}

export function secureApplicationResponse(response: Response, noStore = false) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: secureHeaders(response.headers, { noStore }),
  });
}

export function crossOriginRequestResponse(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const configuredOrigin = process.env.DJMIMA_PUBLIC_ORIGIN?.trim();
  let expectedOrigin = new URL(request.url).origin;
  try {
    if (configuredOrigin) {
      expectedOrigin = new URL(configuredOrigin).origin;
    } else if (process.env.DJMIMA_TRUST_PROXY === "1") {
      const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
      if (protocol && host) expectedOrigin = new URL(`${protocol}://${host}`).origin;
    }
  } catch {
    // Invalid deployment configuration fails closed below because the derived
    // request origin will not match the browser's configured production origin.
  }

  // 所有写操作都必须来自本站页面。缺少 Origin、不同源或非同源 Fetch
  // 都按 CSRF 处理，不能为了 curl 或旧客户端静默放行。
  if (origin !== expectedOrigin || fetchSite !== "same-origin") {
    return secureJson({ error: "已拒绝跨站请求。请从 djmima 页面重新操作。", code: "CSRF_REJECTED" }, { status: 403 });
  }
  return null;
}
