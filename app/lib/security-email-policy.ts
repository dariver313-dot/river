export function securityEmailConfirmationRequired(input: {
  currentEmail: string | null | undefined;
  verifiedAt: string | null | undefined;
  targetEmail: string;
}) {
  const current = input.currentEmail?.trim().toLowerCase() ?? "";
  const target = input.targetEmail.trim().toLowerCase();
  return current !== target || !input.verifiedAt;
}
