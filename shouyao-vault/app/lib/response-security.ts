const applicationSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
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
  if (!origin || origin === new URL(request.url).origin) return null;
  return secureJson({ error: "已拒绝跨站请求。请从守钥页面重新操作。" }, { status: 403 });
}
