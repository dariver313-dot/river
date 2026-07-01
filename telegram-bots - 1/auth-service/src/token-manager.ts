/**
 * Token 管理器 - 内存缓存 + 自动刷新
 *
 * 管理所有平台的 Token，提供统一的获取/刷新/过期检测/撤销接口。
 * Token 不落盘，进程重启后通过自动登录恢复。
 */

import { performAutoLogin, type AutoLoginConfig, type LoginResult } from './auto-login';
import { performPlatformBLogin, type PlatformBLoginConfig, type PlatformBLoginResult } from './auto-login-b';
import { setLogtoken } from './platforms/platform-a';

const log = (level: 'info'|'warn', msg: string, meta?: any) => {
  const line = `[TokenManager] ${msg}` + (meta ? ' ' + JSON.stringify(meta) : '');
  if (level === 'warn') console.warn(line); else console.log(line);
};

export interface TokenEntry {
  token: string | null;
  lastUpdated: number;
  expiresAt: number | null;
  refreshing: boolean;
  refreshPromise: Promise<string | null> | null;
}

type TokenKey = 'platform_a' | 'platform_b';

const TOKEN_TTL = 12 * 60 * 60 * 1000;
const REFRESH_INTERVAL = 4 * 60 * 60 * 1000;
// SOFT_TTL: Token 过期后的宽限期。过期但未超过 SOFT_TTL 时，getToken 仍返回旧 token（同时触发后台刷新）；
// 超过 SOFT_TTL 则视为彻底失效，getToken 返回 null。可通过 SOFT_TTL_MINUTES 环境变量覆盖（默认5分钟）。
const SOFT_TTL = parseInt(process.env.SOFT_TTL_MINUTES || '5', 10) * 60 * 1000;

/** 连续登录失败上限，超过后停止自动刷新（防止触发上游风控锁账户） */
const MAX_CONSECUTIVE_FAILURES = 5;

type LoginConfig = AutoLoginConfig | PlatformBLoginConfig;

/** 通过 platform 字段区分配置类型，比字段存在性检测更可靠 */
function isPlatformBConfig(config: LoginConfig): config is PlatformBLoginConfig {
  return (config as PlatformBLoginConfig).platform === 'b';
}

class TokenManager {
  private cache = new Map<TokenKey, TokenEntry>();
  private refreshTimers = new Map<TokenKey, ReturnType<typeof setTimeout>>();
  private refreshConfigs = new Map<TokenKey, LoginConfig>();
  private refreshCallbacks = new Map<TokenKey, (newToken: string) => void>();
  private stopped = new Map<TokenKey, boolean>();
  private consecutiveFailures = new Map<TokenKey, number>();

  /** 设置 Token */
  setToken(key: TokenKey, token: string, expiresInMs?: number): void {
    const now = Date.now();
    this.cache.set(key, {
      token,
      lastUpdated: now,
      expiresAt: expiresInMs ? now + expiresInMs : now + TOKEN_TTL,
      refreshing: false,
      refreshPromise: null,
    });
  }

  /** 获取 Token，如果过期则触发自动刷新 */
  getToken(key: TokenKey): string | null {
    const entry = this.cache.get(key);
    if (!entry || !entry.token) return null;

    if (entry.expiresAt) {
      const now = Date.now();
      if (now > entry.expiresAt + SOFT_TTL) {
        this.triggerRefresh(key);
        return null;
      }
      if (now > entry.expiresAt) {
        this.triggerRefresh(key);
      }
    }

    return entry.token;
  }

  /** 获取 Token（即使过期也返回，用于尝试性请求） */
  getTokenForce(key: TokenKey): string | null {
    return this.cache.get(key)?.token ?? null;
  }

  /** 标记 Token 已失效（触发自动刷新）。
   *  旧 token 在刷新成功前保留，避免刷新失败导致所有请求立即报错。
   *  重试期间保持 refreshing 锁 + refreshPromise，防止并发多次登录。
   *  并发调用共享同一个 refreshPromise，避免重复登录。 */
  async invalidateToken(key: TokenKey): Promise<string | null> {
    const entry = this.cache.get(key);

    // 如果已经在刷新中，共享同一个 Promise，避免并发重复登录
    if (entry?.refreshing && entry.refreshPromise) {
      return entry.refreshPromise;
    }

    if (entry) {
      entry.expiresAt = Date.now() - 1;
    }

    const config = this.refreshConfigs.get(key);
    if (!config) {
      if (entry) entry.expiresAt = Date.now() + SOFT_TTL;
      return null;
    }

    // 创建带重试的刷新 Promise，并存储到 entry 以便并发调用共享
    const refreshPromise = this._invalidateWithRetry(key, config);
    if (entry) {
      entry.refreshing = true;
      entry.refreshPromise = refreshPromise;
    }

    try {
      return await refreshPromise;
    } finally {
      if (entry) {
        entry.refreshing = false;
        entry.refreshPromise = null;
      }
    }
  }

  /** 带重试的刷新逻辑（最多3次，指数退避） */
  private async _invalidateWithRetry(key: TokenKey, config: LoginConfig): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const newToken = await this._doRefresh(key, config);
      if (newToken) {
        this.consecutiveFailures.set(key, 0);
        return newToken;
      }
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, attempt)));
      }
    }

    // 刷新失败：保留旧 token（可能仍部分有效），仅标记为过期
    const entry = this.cache.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + SOFT_TTL;
    }
    return null;
  }

  /** 触发后台刷新（不等待结果） */
  private triggerRefresh(key: TokenKey): void {
    const config = this.refreshConfigs.get(key);
    if (!config) return;

    const entry = this.cache.get(key);
    if (!entry || entry.refreshing) return;

    entry.refreshing = true;
    this.refreshToken(key, config).catch((err) => {
      log('warn', '后台刷新失败', { key, err: err?.message?.slice(0, 100) || String(err) });
    });
  }

  /** 刷新 Token（自动登录），并发调用共享同一个 Promise */
  async refreshToken(key: TokenKey, config: LoginConfig): Promise<string | null> {
    const entry = this.cache.get(key);

    if (entry?.refreshing && entry.refreshPromise) {
      return entry.refreshPromise;
    }

    if (entry) entry.refreshing = true;

    const refreshPromise = this._doRefresh(key, config);
    if (entry) entry.refreshPromise = refreshPromise;

    try {
      const newToken = await refreshPromise;
      return newToken;
    } finally {
      if (entry) {
        entry.refreshing = false;
        entry.refreshPromise = null;
      }
    }
  }

  /** 实际执行登录。平台A 使用平台返回的 tokenExpireIn 作为 TTL */
  private async _doRefresh(key: TokenKey, config: LoginConfig): Promise<string | null> {
    let result: string | null = null;
    if (isPlatformBConfig(config)) {
      const r: PlatformBLoginResult | null = await performPlatformBLogin(config);
      if (r?.token) {
        this.setToken(key, r.token, r.estimatedTtlMs);
        const cb = this.refreshCallbacks.get(key);
        if (cb) cb(r.token);
        result = r.token;
      }
    } else {
      const r: LoginResult | null = await performAutoLogin(config);
      if (r?.token) {
        this.setToken(key, r.token, r.expiresInMs);
        setLogtoken(r.accessLogToken || '');
        const cb = this.refreshCallbacks.get(key);
        if (cb) cb(r.token);
        result = r.token;
      }
    }

    // 失败计数：连续失败超过阈值时停止自动刷新，防止触发上游风控锁账户
    if (result) {
      this.consecutiveFailures.set(key, 0);
    } else {
      const failures = (this.consecutiveFailures.get(key) || 0) + 1;
      this.consecutiveFailures.set(key, failures);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        log('warn', `连续登录失败 ${failures} 次，停止自动刷新`, { key });
        this.stopped.set(key, true);
      }
    }
    return result;
  }

  /** 撤销 Token（立即失效 + 停止自动刷新）
   *  用于 Token 泄露等紧急场景，调用后该平台 Token 彻底失效，
   *  需通过 setToken 或重启后自动登录恢复。 */
  revokeToken(key: TokenKey): string | null {
    const entry = this.cache.get(key);
    const oldToken = entry?.token ?? null;

    // 停止自动刷新，防止用泄露的凭证自动续期
    this.stopAutoRefresh(key);
    // 清除缓存条目
    this.cache.delete(key);
    // 重置失败计数
    this.consecutiveFailures.set(key, 0);

    if (oldToken) {
      log('info', 'Token 已撤销', { key });
    }
    return oldToken;
  }

  /** 获取所有 Token 状态 */
  getStatus(): Record<string, { hasToken: boolean; lastUpdated: string | null; expiresAt: string | null }> {
    const result: Record<string, { hasToken: boolean; lastUpdated: string | null; expiresAt: string | null }> = {};
    for (const [key, entry] of this.cache) {
      result[key] = {
        hasToken: !!entry.token && (entry.expiresAt ? Date.now() < entry.expiresAt : true),
        lastUpdated: entry.lastUpdated ? new Date(entry.lastUpdated).toISOString() : null,
        expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      };
    }
    return result;
  }

  /** 启动定时刷新（Token 过期前自动续期）。
   *  刷新失败时自动缩短间隔（5分钟重试），成功后恢复原始间隔。
   *  连续失败超过 MAX_CONSECUTIVE_FAILURES 次时自动停止。 */
  startAutoRefresh(key: TokenKey, config: LoginConfig, intervalMs: number = REFRESH_INTERVAL, onRefresh?: (newToken: string) => void): void {
    this.stopAutoRefresh(key);
    this.refreshConfigs.set(key, config);
    if (onRefresh) this.refreshCallbacks.set(key, onRefresh);
    this.stopped.set(key, false);
    this.consecutiveFailures.set(key, 0);

    const RETRY_INTERVAL = 5 * 60 * 1000;
    let currentInterval = intervalMs;

    const schedule = () => {
      if (this.stopped.get(key)) return; // 已停止，不再调度
      const timer = setTimeout(async () => {
        if (this.stopped.get(key)) return; // 定时器触发时再次检查
        try {
          await this.refreshToken(key, config);
          if (currentInterval !== intervalMs) {
            currentInterval = intervalMs;
            log('info', 'refresh ok, reset interval', { key, min: intervalMs / 60000 });
          }
        } catch {
          if (currentInterval !== RETRY_INTERVAL) {
            currentInterval = RETRY_INTERVAL;
            log('warn', 'refresh fail, retry in 5min', { key });
          }
        }
        schedule();
      }, currentInterval);
      this.refreshTimers.set(key, timer);
    };

    schedule();
  }

  /** 停止定时刷新 */
  stopAutoRefresh(key: TokenKey): void {
    this.stopped.set(key, true);
    const timer = this.refreshTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(key);
    }
  }

  /** 停止所有定时器 */
  stopAll(): void {
    for (const key of this.refreshTimers.keys()) {
      this.stopAutoRefresh(key);
    }
  }
}

export const tokenManager = new TokenManager();
export type { TokenKey };
