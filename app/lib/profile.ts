export const profileAvatarStyles = ["sage", "sky", "violet", "amber", "rose"] as const;

export type ProfileAvatarStyle = (typeof profileAvatarStyles)[number];

export type AccountProfile = {
  displayName: string;
  avatarStyle: ProfileAvatarStyle;
};

export function profileAvatarStyle(value: unknown): ProfileAvatarStyle {
  return typeof value === "string" && (profileAvatarStyles as readonly string[]).includes(value)
    ? value as ProfileAvatarStyle
    : "sage";
}

export function profileDisplayName(value: unknown, fallback: string) {
  return normalizeProfileDisplayName(value) ?? fallback;
}

export function normalizeProfileDisplayName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || [...normalized].length > 32 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}
