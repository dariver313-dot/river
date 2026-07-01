/**
 * 平台B 自动登录模块（SM4 + MD5时间戳加密密码）
 *
 * 登录流程：
 *   POST /livepro/backmanager/login
 *   密码加密：SM4-ECB(MD5(timestamp).toLowerCase() as key, password)
 *   请求头：X-TIMESTAMP: timestamp
 */

import axios from 'axios';
import crypto from 'crypto';
import { SM4 } from 'gm-crypto';
import { generateTOTP } from './totp';
import { RETRY_MAX_ATTEMPTS, retryBackoff, sleep } from './constants';

export interface PlatformBLoginConfig {
  /** 平台标识，用于 token-manager 区分配置类型 */
  platform: 'b';
  baseUrl: string;
  account: string;
  password: string;
  totpSecret: string;
  /** 登录时使用的租户代码（浏览器中为 CSZH），不传则不发送 */
  tenantCode?: string;
}

export interface PlatformBLoginResult {
  token: string;
  /** 估算的 Token 有效期（毫秒），通过探测请求得出；无法探测时为 null */
  estimatedTtlMs?: number;
}

interface LoginResponse {
  success: boolean;
  code: string;
  msg: string | null;
  data: string; // JSON字符串
}

interface LoginData {
  token: string;
  needBindGoogle: boolean;
  restPwd: number;
  tenantCode: string;
  tenantName: string;
}

const FIXED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// 进程级固定 device-id：登录和后续请求必须使用同一个值，
// 否则平台B后台会因 device-id 与登录时不一致而强制过期 Token
// 格式必须与浏览器一致：H5| + 10位数字
const FIXED_DEVICE_ID = 'H5|' + crypto.randomInt(1_000_000_000, 10_000_000_000);
export { FIXED_DEVICE_ID };

let loginLock: Promise<PlatformBLoginResult | null> | null = null;
let loginLockResolve: ((value: PlatformBLoginResult | null) => void) | null = null;

/** 重置登录锁（供测试使用） */
export function resetPlatformBLoginLock(): void {
  loginLock = null;
  loginLockResolve = null;
}

/**
 * SM4加密密码（与前端一致）
 *
 * 流程：
 * 1. sm4Key = MD5(timestamp).toLowerCase()  → 32位hex小写
 * 2. encrypted = SM4.encrypt(password, sm4Key, ECB, PKCS7) → hex
 * 3. result = Base64(HexToBytes(encrypted))
 */
function encryptPasswordForLogin(password: string, timestamp: string): string {
  const sm4Key = crypto.createHash('md5').update(timestamp).digest('hex').toLowerCase();
  const encrypted = SM4.encrypt(password, sm4Key, {
    mode: SM4.constants.ECB,
    outputEncoding: 'hex',
  });
  const hexBuf = Buffer.from(encrypted, 'hex');
  return hexBuf.toString('base64');
}

/** 执行平台B自动登录，返回 token + 估算TTL 或 null */
export async function performPlatformBLogin(config: PlatformBLoginConfig): Promise<PlatformBLoginResult | null> {
  // 如果已有锁，等待其结果（并发调用共享同一个 Promise）
  if (loginLock) return loginLock;

  // 创建新的锁 Promise
  loginLock = new Promise<PlatformBLoginResult | null>((resolve) => {
    loginLockResolve = resolve;
  });

  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');

    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const timestamp = String(Date.now());
        const encryptedPassword = encryptPasswordForLogin(config.password, timestamp);
        // 检查当前 TOTP 窗口剩余有效期，不足5秒则等待到下一个窗口
        const WINDOW_SEC = 30;
        const MIN_REMAINING_SEC = 5;
        const remainingInWindow = WINDOW_SEC - (Math.floor(Date.now() / 1000) % WINDOW_SEC);
        if (remainingInWindow < MIN_REMAINING_SEC && remainingInWindow >= 0) {
          await sleep((remainingInWindow + 1) * 1000);
        } else if (remainingInWindow < 0) {
          console.warn(`[TOTP] 时钟偏差: remainingInWindow=${remainingInWindow}s`);
        }
        const googleCode = generateTOTP(config.totpSecret);

        const loginRes = await axios.post(
          `${baseUrl}/livepro/backmanager/login`,
          {
            operatorName: config.account.trim(),
            password: encryptedPassword,
            googleCode,
            ipAddress: '',
          },
          {
            headers: {
              'Content-Type': 'application/json;charset=UTF-8',
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Origin': baseUrl,
              'Referer': `${baseUrl}/`,
              'Cookie': 'sidebarStatus=0',
              'Lang': 'zh-CN',
              'Request-Encrypt': 'true',
              'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"',
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin',
              'X-Bg-Req-Id': crypto.randomBytes(8).toString('base64url').slice(0, 12),
              'X-Device-Id': FIXED_DEVICE_ID,
              'X-Tenant-Code': config.tenantCode || 'CSZH',
              'X-Timestamp': timestamp,
              'User-Agent': FIXED_UA,
            },
            timeout: 15000,
          },
        );

        const resData = loginRes.data as LoginResponse;

        if (!resData.success || resData.code !== '200') {
          // 脱敏：上游错误消息可能包含账户信息
          const safeMsg = (resData.msg || '未知错误').replace(/(account|operatorName|password|googleCode)=\S*/gi, '$1=***');
          console.error(`[平台B登录] 失败: ${safeMsg}`);
          if (attempt < RETRY_MAX_ATTEMPTS - 1) await sleep(retryBackoff(attempt));
          continue;
        }

        // data 是 JSON 字符串，需要解析
        let loginData: LoginData;
        try {
          loginData = JSON.parse(resData.data);
        } catch {
          console.error('[平台B登录] 响应data解析失败');
          if (attempt < RETRY_MAX_ATTEMPTS - 1) await sleep(retryBackoff(attempt));
          continue;
        }

        if (!loginData.token) {
          console.error('[平台B登录] 未获取到token');
          if (attempt < RETRY_MAX_ATTEMPTS - 1) await sleep(retryBackoff(attempt));
          continue;
        }

        console.log(`[平台B登录] 成功! 租户: ${loginData.tenantName} (${loginData.tenantCode})`);
        const result: PlatformBLoginResult = { token: loginData.token, estimatedTtlMs: 12 * 60 * 60 * 1000 };
        loginLockResolve?.(result);
        return result;

      } catch (err: any) {
        console.error(`[平台B登录] 异常 (尝试 ${attempt + 1}/${RETRY_MAX_ATTEMPTS}): ${err.message}`);
        if (attempt < RETRY_MAX_ATTEMPTS - 1) {
          await sleep(retryBackoff(attempt));
        }
      }
    }

    loginLockResolve?.(null);
    return null;
  } finally {
    loginLock = null;
    loginLockResolve = null;
  }
}
