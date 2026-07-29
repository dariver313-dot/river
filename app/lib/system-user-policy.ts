export type ManagedUserPolicyState = {
  email: string;
  role: "admin" | "user";
  status: "pending" | "active" | "suspended" | "frozen";
};

export function assertSystemUserChangeAllowed(input: {
  actorEmail: string;
  target: ManagedUserPolicyState;
  configuredPrimaryAdminEmail: string | null;
  nextRole: ManagedUserPolicyState["role"];
  nextStatus: ManagedUserPolicyState["status"];
  activeAdminCount: number;
}) {
  const isProtectedAdmin = input.target.email === input.actorEmail || input.target.email === input.configuredPrimaryAdminEmail;
  if (isProtectedAdmin && (input.nextRole !== "admin" || input.nextStatus !== "active")) {
    throw new Error("不能降低或停用当前的主管理员账户。");
  }

  const removesActiveAdmin = input.target.role === "admin" && input.target.status === "active"
    && (input.nextRole !== "admin" || input.nextStatus !== "active");
  if (removesActiveAdmin && input.activeAdminCount <= 1) {
    throw new Error("系统至少需要保留一位有效管理员。");
  }
}

export function assertSystemUserDeletionAllowed(input: {
  actorEmail: string;
  target: ManagedUserPolicyState;
  configuredPrimaryAdminEmail: string | null;
  activeAdminCount: number;
}) {
  if (input.target.email === input.actorEmail || input.target.email === input.configuredPrimaryAdminEmail) {
    throw new Error("不能删除当前的主管理员账户。");
  }
  if (input.target.role === "admin" && input.target.status === "active" && input.activeAdminCount <= 1) {
    throw new Error("系统至少需要保留一位有效管理员。");
  }
}
