export function normalizeLoginAccount(value: string) {
  return value.trim().toLowerCase();
}

export function isEmailLoginAccount(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Existing email accounts remain valid; new usernames are 4–32 ASCII letters and digits, and include both. */
export function isValidLoginAccount(value: string) {
  if (isEmailLoginAccount(value)) return value.length <= 254;
  return /^(?=.{4,32}$)(?=.*[a-z])(?=.*\d)[a-z][a-z\d]*$/.test(value);
}

export function accountDisplayName(account: string) {
  return account.includes('@') ? account.slice(0, account.indexOf('@')) || account : account;
}
