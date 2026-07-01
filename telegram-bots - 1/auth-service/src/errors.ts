/**
 * 类型化错误类 — 替代字符串匹配的错误检测
 *
 * 使用方式：
 *   if (e instanceof TokenExpiredError) { ... }
 *   而非 if (e.message.includes('401')) { ... }
 */

/** Token 过期/无效错误 */
export class TokenExpiredError extends Error {
  readonly code = 'TOKEN_EXPIRED' as const;
  constructor(message = 'Token 已过期') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

/** 上游配置错误（baseUrl 未设置等） */
export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 上游限流错误 */
export class RateLimitError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number = 5000) {
    super('请求被限流（HTTP 429）');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 上游业务错误（非 Token/限流） */
export class UpstreamError extends Error {
  readonly code = 'UPSTREAM_ERROR' as const;
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = statusCode;
  }
}
