import { ClientSafeError } from "./security-errors.ts";

export type ManagedUserPolicyState = {
  email: string;
  role: "admin" | "user";
  status: "pending" | "active" | "suspended" | "frozen";
};

/** A pending account can become active only after proving its activation TOTP. */
export function assertSystemUserStatusTransitionAllowed(currentStatus: ManagedUserPolicyState["status"], nextStatus: ManagedUserPolicyState["status"]) {
  if (currentStatus !== nextStatus && (currentStatus === "pending" || nextStatus === "pending")) {
    throw new ClientSafeError("待激活账户只能通过激活确认流程变更状态。", 409, "USER_STATUS_TRANSITION_INVALID");
  }
}

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
    throw new ClientSafeError("不能降低或停用当前的主管理员账户。", 409, "PRIMARY_ADMIN_PROTECTED");
  }

  const removesActiveAdmin = input.target.role === "admin" && input.target.status === "active"
    && (input.nextRole !== "admin" || input.nextStatus !== "active");
  if (removesActiveAdmin && input.activeAdminCount <= 1) {
    throw new ClientSafeError("系统至少需要保留一位有效管理员。", 409, "ACTIVE_ADMIN_REQUIRED");
  }
}

export function assertSystemUserDeletionAllowed(input: {
  actorEmail: string;
  target: ManagedUserPolicyState;
  configuredPrimaryAdminEmail: string | null;
  activeAdminCount: number;
}) {
  if (input.target.email === input.actorEmail || input.target.email === input.configuredPrimaryAdminEmail) {
    throw new ClientSafeError("不能删除当前的主管理员账户。", 409, "PRIMARY_ADMIN_PROTECTED");
  }
  if (input.target.role === "admin" && input.target.status === "active" && input.activeAdminCount <= 1) {
    throw new ClientSafeError("系统至少需要保留一位有效管理员。", 409, "ACTIVE_ADMIN_REQUIRED");
  }
}
