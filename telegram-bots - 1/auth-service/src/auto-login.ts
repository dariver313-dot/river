/**
 * 自动登录编排模块（平台1 - Bearer JWT 体系）
 *
 * 两步认证流程：
 *   Step 1: POST /api/admin/auth/login  → 获取临时 accessToken
 *   Step 2: POST /api/admin/auth/verify2fa → 获取完整 accessToken
 */

import axios from 'axios';
import { generateTOTP } from './totp';
import { encryptPassword } from './rsa-encrypt';
import { RETRY_MAX_ATTEMPTS, retryBackoff, sleep } from './constants';

export interface AutoLoginConfig {
  baseUrl: string;
  account: string;
  password: string;
  totpSecret: string;
  rsaPublicKey: string;
}

interface LoginResponse {
  code: number;
  message?: string;
  data?: {
    accessToken?: string;
    accessLogToken?: string;
    authenticated?: boolean;
    enable2FA?: boolean;
  };
}

interface Verify2faResponse {
  code: number;
  message?: string;
  data?: {
    accessToken?: string;
    refreshToken?: string;
    tokenExpireIn?: number;  // 毫秒时间戳
  };
}

export interface LoginResult {
  token: string;
  expiresInMs?: number;  // 毫秒
  accessLogToken?: string;  // 登录响应中的 logtoken，后续请求 Cookie 需要携带
}

const FIXED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

let autoLoginLock: Promise<LoginResult | null> | null = null;
let autoLoginLockResolve: ((value: LoginResult | null) => void) | null = null;

/** 重置登录锁（供测试使用） */
export function resetAutoLoginLock(): void {
  autoLoginLock = null;
  autoLoginLockResolve = null;
}

/** 执行两步自动登录，返回 token + 有效期 */
export async function performAutoLogin(config: AutoLoginConfig): Promise<LoginResult | null> {
  // 如果已有锁，等待其结果（并发调用共享同一个 Promise）
  if (autoLoginLock) return autoLoginLock;

  // 创建新的锁 Promise
  autoLoginLock = new Promise<LoginResult | null>((resolve) => {
    autoLoginLockResolve = resolve;
  });

  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');

    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        // Step 1: 登录获取临时 token
        const encryptedPassword = encryptPassword(config.password, config.rsaPublicKey);
        const loginRes = await axios.post(
          `${baseUrl}/api/admin/auth/login?account=${encodeURIComponent(config.account)}&password=${encodeURIComponent(encryptedPassword)}`,
          undefined,
          {
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Origin': baseUrl,
              'Referer': `${baseUrl}/`,
              'Langue': 'zh-CN',
              'X-Time-Zone': 'Asia/Shanghai',
              'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"',
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin',
              'User-Agent': FIXED_UA,
            },
            timeout: 10000,
          },
        );

        const loginData = loginRes.data as LoginResponse;
        if (loginData.code !== 0 || !loginData.data?.accessToken) {
          if (attempt < RETRY_MAX_ATTEMPTS - 1) await sleep(retryBackoff(attempt));
          continue;
        }

        const tempToken = loginData.data.accessToken;
        const accessLogToken = loginData.data.accessLogToken || '';

        if (!loginData.data.enable2FA) {
          autoLoginLockResolve?.({ token: tempToken, accessLogToken });
          return { token: tempToken, accessLogToken };
        }

        // Step 2: TOTP 验证
        // 检查当前 TOTP 窗口剩余有效期，不足5秒则等待到下一个窗口
        const WINDOW_SEC = 30;
        const MIN_REMAINING_SEC = 5;
        const remainingInWindow = WINDOW_SEC - (Math.floor(Date.now() / 1000) % WINDOW_SEC);
        if (remainingInWindow < MIN_REMAINING_SEC && remainingInWindow >= 0) {
          await sleep((remainingInWindow + 1) * 1000);
        } else if (remainingInWindow < 0) {
          console.warn(`[TOTP] 时钟偏差: remainingInWindow=${remainingInWindow}s`);
        }
        const totpCode = generateTOTP(config.totpSecret);
        // 构建 2FA Cookie：包含 logtoken（来自登录响应的 accessLogToken）
        const verifyCookies = [
          'language=zh-CN',
          'GooglekeY=1',
          'enable2fa=true',
          `token=${tempToken}`,
          'sidebarStatus=0',
          accessLogToken ? `logtoken=${accessLogToken}` : '',
        ].filter(Boolean).join('; ');
        const verifyRes = await axios.post(
          `${baseUrl}/api/admin/auth/verify2fa?code=${totpCode}`,
          undefined,
          {
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Authorization': `Bearer ${tempToken}`,
              'Cookie': verifyCookies,
              'Origin': baseUrl,
              'Referer': `${baseUrl}/`,
              'Langue': 'zh-CN',
              'X-Time-Zone': 'Asia/Shanghai',
              'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"',
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin',
              'User-Agent': FIXED_UA,
            },
            timeout: 10000,
          },
        );

        const verifyData = verifyRes.data as Verify2faResponse;
        if (verifyData.code !== 0 || !verifyData.data?.accessToken) {
          if (attempt < RETRY_MAX_ATTEMPTS - 1) {
            // 2FA 验证失败：等待到下一个 TOTP 窗口 + 退避，避免 TOTP 码跨窗口无效
            await sleep(Math.max(WINDOW_SEC * 1000, retryBackoff(attempt)));
          }
          continue;
        }

        const finalToken = verifyData.data.accessToken;
        // tokenExpireIn 是毫秒时间戳（如 1781156491000），不是秒
        // 计算剩余有效期 = tokenExpireIn - 当前时间
        const tokenExpireIn = verifyData.data.tokenExpireIn;
        let expiresInMs: number | undefined;
        if (tokenExpireIn) {
          const remaining = tokenExpireIn - Date.now();
          expiresInMs = remaining > 0 ? remaining : undefined;
        }
        autoLoginLockResolve?.({ token: finalToken, expiresInMs, accessLogToken });
        return { token: finalToken, expiresInMs, accessLogToken };

      } catch (err) {
        if (attempt < RETRY_MAX_ATTEMPTS - 1) {
          await sleep(retryBackoff(attempt));
        }
      }
    }

    autoLoginLockResolve?.(null);
    return null;
  } finally {
    autoLoginLock = null;
    autoLoginLockResolve = null;
  }
}
