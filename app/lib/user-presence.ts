export const onlineActivityWindowMs = 5 * 60_000;

export type AuthSessionPresence = {
  expiresAt: string;
  lastActiveAt: string;
  revokedAt: string | null;
};

function timestamp(value: string) {
  return Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}

/** A session is online only while it is valid and has been active very recently. */
export function isAuthSessionOnline(session: AuthSessionPresence, now = Date.now()) {
  if (session.revokedAt) return false;
  const expiresAt = timestamp(session.expiresAt);
  const lastActiveAt = timestamp(session.lastActiveAt);
  return !Number.isNaN(expiresAt) && !Number.isNaN(lastActiveAt)
    && expiresAt > now && lastActiveAt >= now - onlineActivityWindowMs;
}
