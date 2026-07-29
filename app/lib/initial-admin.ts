import { isValidLoginAccount, normalizeLoginAccount } from "./identity";

/** The bootstrap administrator is configured by deployment, never inferred from browser activity. */
export function initialAdminAccount() {
  const account = normalizeLoginAccount(process.env.PRIMARY_ADMIN_ACCOUNT ?? process.env.PRIMARY_ADMIN_EMAIL ?? "");
  return isValidLoginAccount(account) ? account : null;
}

export function isInitialAdminAccount(account: string) {
  const initialAdmin = initialAdminAccount();
  return Boolean(initialAdmin && normalizeLoginAccount(account) === initialAdmin);
}
