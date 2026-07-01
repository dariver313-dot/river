/**
 * SM4-ECB 解密模块（平台B响应解密）
 *
 * ⚠️ 安全警告：ECB 模式对相同明文块产生相同密文，无法提供语义安全性。
 * 当前使用 ECB 模式是因为后端 API 仅支持此模式，后续应推动后端升级为 SM4-CBC/GCM。
 */
import crypto from 'crypto';
import { sm4 } from 'sm-crypto-v2';

let cachedToken = '';
let cachedKeyHex = '';
let cachedKeyBuf: Buffer | null = null;
// nativeSm4Available 检测结果缓存，首次检测后不再变化（仅在同一 Node.js 进程内有效）
let nativeSm4Available: boolean | null = null;

function deriveKeyHex(token: string): string {
  if (token === cachedToken && cachedKeyHex) return cachedKeyHex;
  cachedKeyHex = crypto.createHash('md5').update(token, 'utf-8').digest('hex').toUpperCase();
  cachedToken = token;
  cachedKeyBuf = null;
  return cachedKeyHex;
}

function getKeyBuffer(token: string): Buffer {
  deriveKeyHex(token);
  if (!cachedKeyBuf) {
    cachedKeyBuf = Buffer.from(cachedKeyHex, 'hex');
  }
  return cachedKeyBuf;
}

function isNativeSm4Available(): boolean {
  if (nativeSm4Available !== null) return nativeSm4Available;
  try {
    crypto.createDecipheriv('sm4-ecb', Buffer.alloc(16), null);
    nativeSm4Available = true;
  } catch {
    nativeSm4Available = false;
  }
  return nativeSm4Available;
}

/** SM4-ECB 解密后台加密响应 */
export function decryptResponse<T = unknown>(encryptedB64: string, token: string): T {
  if (isNativeSm4Available()) {
    return decryptNative<T>(encryptedB64, token);
  }
  return decryptLegacy<T>(encryptedB64, token);
}

function decryptNative<T = unknown>(encryptedB64: string, token: string): T {
  const keyBuf = getKeyBuffer(token);
  const encryptedBuf = Buffer.from(encryptedB64, 'base64');

  const decipher = crypto.createDecipheriv('sm4-ecb', keyBuf, null);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(encryptedBuf);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return JSON.parse(decrypted.toString('utf-8'));
}

function decryptLegacy<T = unknown>(encryptedB64: string, token: string): T {
  const key = deriveKeyHex(token);
  const encryptedHex = Buffer.from(encryptedB64, 'base64').toString('hex');
  const decrypted = sm4.decrypt(encryptedHex, key, {
    mode: 'ecb',
    padding: 'pkcs#7',
    output: 'string',
  }) as string;
  return JSON.parse(decrypted);
}

/** 清除 SM4 密钥缓存（Token 刷新时调用，确保下次解密使用新密钥） */
export function clearSm4Cache(): void {
  cachedToken = '';
  cachedKeyHex = '';
  cachedKeyBuf = null;
}
