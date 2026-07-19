export const canonicalPublicVaultId = "djmima-shared-public-vault";

type PublicVaultCandidate = { id: string };

/**
 * The configured ID is authoritative only while it still points to a public
 * vault. When it is stale, callers fall back to the oldest valid vault and
 * persist that choice again.
 */
export function resolveSharedPublicVault<T extends PublicVaultCandidate>(
  configuredId: string | null | undefined,
  candidates: readonly T[],
): T | null {
  return candidates.find((candidate) => candidate.id === configuredId) ?? candidates[0] ?? null;
}
