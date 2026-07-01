/**
 * AES-256-GCM 加密/解密工具
 *
 * 用于加密 .env 中的敏感字段（密码、TOTP密钥等）
 * 密钥通过 AUTH_SECRET_KEY 环境变量注入，不写文件
 *
 * 加密格式：hex(iv):hex(authTag):hex(ciphertext)
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // GCM 推荐 12 字节
const AUTH_TAG_LENGTH = 16;  // GCM auth tag 16 字节

/** 获取解密密钥（32字节 = 256位） */
function getSecretKey(): Buffer {
  const key = process.env.AUTH_SECRET_KEY;
  if (!key) {
    throw new Error('AUTH_SECRET_KEY 环境变量未设置。启动方式：AUTH_SECRET_KEY=xxx node dist/index.js');
  }

  // 支持 hex 格式（64字符 = 32字节）或 utf8 格式（≥32字节）
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }

  // 按字节截断（非字符），避免多字节 UTF-8 字符导致密钥 < 32 字节
  const keyBytes = Buffer.from(key, 'utf-8');
  if (keyBytes.length >= 32) {
    return keyBytes.subarray(0, 32);
  }

  throw new Error('AUTH_SECRET_KEY 必须是64位hex或至少32字节的utf8字符串');
}

/**
 * 加密明文
 * @returns hex(iv):hex(authTag):hex(ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = getSecretKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * 解密密文
 * @param encrypted hex(iv):hex(authTag):hex(ciphertext)
 * @returns 明文
 */
export function decrypt(encrypted: string): string {
  const key = getSecretKey();
  const parts = encrypted.split(':');

  if (parts.length !== 3) {
    throw new Error('加密格式无效，应为 hex(iv):hex(authTag):hex(ciphertext)');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}

// env() 解密缓存，避免每次请求都执行 AES-GCM 解密
const ENV_CACHE_TTL = 10 * 60 * 1000; // 10分钟TTL，允许密钥轮换后自动刷新
const ENV_CACHE_MAX = 100; // 缓存条目上限
const envCache = new Map<string, { value: string; cachedAt: number }>();

/**
 * 安全读取环境变量：优先读 _ENC 版本并解密，否则读明文版本
 *
 * 例如：env('PLATFORM_A_TOTP_SECRET')
 *   1. 先读 PLATFORM_A_TOTP_SECRET_ENC → 解密（带缓存，10分钟过期）
 *   2. 没有 _ENC → 读 PLATFORM_A_TOTP_SECRET 明文（兼容旧配置）
 */
export function env(key: string): string {
  // 检查缓存（带 TTL）
  const cached = envCache.get(key);
  if (cached && Date.now() - cached.cachedAt < ENV_CACHE_TTL) {
    return cached.value;
  }

  const encKey = `${key}_ENC`;
  const encValue = process.env[encKey];

  let result: string;
  if (encValue) {
    result = decrypt(encValue);
  } else {
    result = process.env[key] || '';
  }

  envCache.set(key, { value: result, cachedAt: Date.now() });
  // 缓存大小限制：驱逐 TTL 最老（最接近过期）的条目
  if (envCache.size > ENV_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of envCache) {
      if (v.cachedAt < oldestTime) { oldestTime = v.cachedAt; oldestKey = k; }
    }
    if (oldestKey) envCache.delete(oldestKey);
  }
  return result;
}

/** 清除 env 缓存（用于测试或密钥轮换） */
export function clearEnvCache(): void {
  envCache.clear();
}

/**
 * 生成随机密钥（用于 AUTH_SECRET_KEY）
 */
export function generateSecretKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
