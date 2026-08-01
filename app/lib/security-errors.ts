export class ClientSafeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "REQUEST_REJECTED") {
    super(message);
    this.name = "ClientSafeError";
    this.status = status;
    this.code = code;
  }
}

export class SecuritySessionRequiredError extends ClientSafeError {
  constructor() {
    super("安全会话已结束。请重新登录后继续。", 401, "SECURITY_SESSION_REQUIRED");
    this.name = "SecuritySessionRequiredError";
  }
}

export class RecentSecurityConfirmationRequiredError extends ClientSafeError {
  constructor() {
    super("这是一项敏感操作。请重新输入 Google 验证码后继续。", 403, "RECENT_SECURITY_CONFIRMATION_REQUIRED");
    this.name = "RecentSecurityConfirmationRequiredError";
  }
}
