/**
 * Input rules for trusted iframe sources and individual page URLs. Source
 * membership is checked by the database-backed origin store.
 */
function isApplicationOrigin(origin: string) {
  const configuredOrigin = process.env.DJMIMA_PUBLIC_ORIGIN?.trim();
  if (!configuredOrigin) return false;
  try {
    return new URL(configuredOrigin).origin === origin;
  } catch {
    return false;
  }
}

export function normalizeEmbeddedOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("请输入可信来源地址。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("可信来源地址格式无效。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("可信来源必须是无路径、无账号密码的 HTTPS 域名，例如 https://reports.example.com。");
  }
  if (isApplicationOrigin(url.origin)) throw new Error("内嵌来源不能使用本应用域名。");
  return url.origin;
}

export function normalizeEmbeddedPageUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("请输入内嵌页面地址。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("内嵌页面地址格式无效。");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("内嵌页面必须使用不含账号密码的 HTTPS 地址。");
  if (isApplicationOrigin(url.origin)) throw new Error("内嵌页面不能使用本应用域名。");
  return { url: url.toString(), origin: url.origin };
}
