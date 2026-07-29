import { redirect } from "next/navigation";
import { getSelfHostedSession, getSelfHostedUser, type SelfHostedAuthenticatedSession, type SelfHostedUser } from "./lib/selfhost-auth";
import { safeInternalPath } from "./lib/safe-navigation";

const signInPath = "/login";
const signOutPath = "/signout";

export type AuthenticatedUser = SelfHostedUser;

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  return getSelfHostedUser();
}

/** The API layer uses this only to bind its short-lived security session to the current login. */
export async function getAuthenticatedSession(): Promise<SelfHostedAuthenticatedSession | null> {
  return getSelfHostedSession();
}

export async function requireAuthenticatedUser(returnTo: string): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (user) return user;
  redirect(signInRedirectPath(returnTo));
}

export function signInRedirectPath(returnTo: string): string {
  return `${signInPath}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function signOutRedirectPath(): string {
  return signOutPath;
}

export function safeRelativeReturnPath(value: string): string {
  const path = safeInternalPath(value);
  const pathname = new URL(path, "https://djmima.invalid").pathname;
  return pathname === signInPath || pathname === signOutPath ? "/" : path;
}
