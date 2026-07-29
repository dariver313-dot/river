const internalNavigationOrigin = "https://djmima.invalid";

function repeatedlyDecode(value: string) {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded;
}

/**
 * Returns a canonical path that is guaranteed to remain on this application.
 * URL parsers treat backslashes as authority separators, so reject both raw
 * and percent-encoded variants before constructing a redirect target.
 */
export function safeInternalPath(value: unknown, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  const decoded = repeatedlyDecode(value);
  if (!decoded || decoded.startsWith("//") || decoded.includes("\\")) return fallback;
  try {
    const target = new URL(decoded, internalNavigationOrigin);
    if (target.origin !== internalNavigationOrigin) return fallback;
    const path = `${target.pathname}${target.search}${target.hash}`;
    return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : fallback;
  } catch {
    return fallback;
  }
}
