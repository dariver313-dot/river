import { redirect } from "next/navigation";
import { getSelfHostedUser, type SelfHostedUser } from "./lib/selfhost-auth";

const signInPath = "/login";
const signOutPath = "/signout";

export type AuthenticatedUser = SelfHostedUser;

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  return getSelfHostedUser();
}

export async function requireAuthenticatedUser(returnTo: string): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (user) return user;
  redirect(signInRedirectPath(returnTo));
}

export function signInRedirectPath(returnTo: string): string {
  return `${signInPath}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function signOutRedirectPath(returnTo = "/"): string {
  return `${signOutPath}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local" || url.pathname === signInPath || url.pathname === signOutPath) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
