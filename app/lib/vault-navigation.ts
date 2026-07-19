import type { SecurityIssue } from "./security-review";

export type VaultPage = "vault" | "profile" | "users";
export type UserManagementTab = "users" | "audit";
export type SecurityFocus = "all" | SecurityIssue;
export type VaultRoute = {
  page: VaultPage;
  collection: "all" | "security";
  securityFocus: SecurityFocus;
  userManagementTab: UserManagementTab;
};

const defaultVaultRoute: VaultRoute = {
  page: "vault",
  collection: "all",
  securityFocus: "all",
  userManagementTab: "users",
};

function securityFocusFromValue(value: string | null): SecurityFocus {
  if (value === "weak_password" || value === "reused_password" || value === "missing_two_factor") return value;
  return "all";
}

export function vaultRouteFromSearch(search: string, isAdmin: boolean): VaultRoute {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "profile") return { ...defaultVaultRoute, page: "profile" };
  if (view === "users" && isAdmin) {
    return { ...defaultVaultRoute, page: "users", userManagementTab: params.get("tab") === "audit" ? "audit" : "users" };
  }
  if (view === "security") {
    return { ...defaultVaultRoute, collection: "security", securityFocus: securityFocusFromValue(params.get("focus")) };
  }
  return defaultVaultRoute;
}

export function vaultRouteSearch(route: VaultRoute): string {
  const params = new URLSearchParams();
  if (route.page === "profile") params.set("view", "profile");
  if (route.page === "users") {
    params.set("view", "users");
    if (route.userManagementTab === "audit") params.set("tab", "audit");
  }
  if (route.collection === "security") {
    params.set("view", "security");
    if (route.securityFocus !== "all") params.set("focus", route.securityFocus);
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}
