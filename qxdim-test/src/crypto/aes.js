/**
 * 企讯达 AES/SM4 加密解密模块
 * 完全还原自 app.1778823952009.js Module 7480
 *
 * 加密模式: AES-128-CBC / SM4-CBC
 * 关键特征: IV = Key（初始化向量与密钥相同）
 * 时间戳: 4字节小端序，从2018-01-01开始的小时数
 *
 * 重要: 原始客户端的加密流程:
 *   明文bytes → hex字符串 → AES加密 → Base64输出
 *   Base64输入 → AES解密 → hex字符串 → bytes
 *
 * ★★★ 源码关键发现 (Module 7480):
 *   AESDecrypt 第3个参数 n 被强制设为 false（废弃）
 *   时间戳验证用第4个参数 o (默认true)
 *   时间戳解析: i[3]&255 → i[2]&255 → i[1]&255 → i[0]&255（大端序！）
 *   但实际上由于 n=false，时间戳差值校验逻辑永远不会执行
 *   解密后如果 length>4，直接 slice(4) 去掉时间戳前缀
 *   如果 length<=4，返回 null
 */

import crypto from 'crypto';
import smCrypto from 'sm-crypto';
import { assertNonEmpty, assertString } from '../utils/validate.js';
import { logger } from '../utils/logger.js';
const sm4 = smCrypto.sm4;

// 默认密钥（硬编码在客户端源码中）
const DEFAULT_KEY = [0, 17, 34, 51, 68, 85, 102, 119, 120, 121, 122, 123, 124, 125, 126, 127];

// 2018-01-01 00:00:00 UTC 的时间戳（秒）
const EPOCH_2018 = 1514736000;

// SM4 模式标志
let useSM4 = false;

// 复用 TextEncoder 实例
const _encoder = new TextEncoder();

// 密钥缓存（keyStr → Uint8Array），避免热路径重复派生
const _keyCache = new Map();
const KEY_CACHE_MAX = 128;

/**
 * 从字符串派生 16 字节密钥
 * 取前16个字符的 charCode，不足部分填零
 * 结果缓存（同一 keyStr 在会话期间不变）
 */
function deriveKey(str) {
  const cached = _keyCache.get(str);
  if (cached) return cached;
  const key = new Uint8Array(16);
  const len = Math.min(str.length, 16);
  for (let i = 0; i < len; i++) {
    key[i] = str.charCodeAt(i);
  }
  if (_keyCache.size >= KEY_CACHE_MAX) {
    _keyCache.delete(_keyCache.keys().next().value);
  }
  _keyCache.set(str, key);
  return key;
}

/**
 * 字节数组转字符串（每个字节→一个字符）
 * 对应源码中的 h() 函数
 * 用 Buffer 一次性转换，O(n) 替代循环拼接的 O(n²)
 */
function bytesToString(bytes) {
  return Buffer.from(bytes).toString('latin1');
}

/**
 * 字符串转 UTF-8 字节数组
 * 对应源码中的 g() 函数
 */
function stringToBytes(str) {
  return Array.from(_encoder.encode(str));
}

/**
 * 字节数组转十六进制字符串
 * 对应源码中的 y() 函数
 * 用 Buffer 一次性转换，O(n) 替代循环拼接的 O(n²)
 */
function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/**
 * 十六进制字符串转字节数组
 * 对应源码中的 m() 函数
 */
function hexToBytes(hex) {
  return Array.from(Buffer.from(hex, 'hex'));
}

/**
 * AES 加密（完全匹配企讯达客户端逻辑）
 * 
 * 原始流程:
 *   1. 构建明文 byte 数组（可选时间戳前缀 + 数据）
 *   2. 将 byte 数组转为 hex 字符串
 *   3. 用 CryptoJS.enc.Hex.parse() 将 hex 字符串转为 WordArray
 *   4. 用 CryptoJS.enc.Utf8.parse(h(keyBytes)) 将密钥转为 WordArray
 *   5. AES-CBC 加密，IV = Key，PKCS7 填充
 *   6. 返回 Base64
 * 
 * @param {string|Buffer|Uint8Array} data - 要加密的数据
 * @param {string} keyStr - 密钥字符串（空字符串使用默认密钥）
 * @param {boolean} includeTimestamp - 是否包含时间戳（默认 true）
 * @returns {string} Base64 编码的密文
 */
export function aesEncrypt(data, keyStr = '', includeTimestamp = true) {
  // 输入校验
  if (data == null) {
    throw new Error('[AES] aesEncrypt: data 不能为 null/undefined');
  }
  if (typeof data !== 'string' && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new Error(`[AES] aesEncrypt: data 必须是 string/Buffer/Uint8Array，收到 ${typeof data}`);
  }
  assertString(keyStr, 'keyStr');

  // 1. 确定密钥
  let keyBytes = DEFAULT_KEY;
  if (keyStr.length > 0) {
    keyBytes = deriveKey(keyStr);
  }

  // 2. SM4 路径（保持 Array 方式，sm-crypto 需要数组输入）
  if (useSM4) {
    let plaintext = [];
    if (includeTimestamp) {
      const hours = Math.floor((Math.floor(Date.now() / 1000) - EPOCH_2018) / 3600);
      plaintext.push(hours & 0xFF);
      plaintext.push((hours >> 8) & 0xFF);
      plaintext.push((hours >> 16) & 0xFF);
      plaintext.push((hours >> 24) & 0xFF);
    }
    if (typeof data === 'string') {
      plaintext = plaintext.concat(stringToBytes(data));
    } else {
      plaintext = plaintext.concat(Array.from(data));
    }
    const keyArr = Array.from(keyBytes);
    const encrypted = sm4.encrypt(plaintext, keyArr, {
      iv: keyArr,
      mode: 'cbc',
      padding: 'pkcs#5',
      output: 'array'
    });
    return Buffer.from(encrypted).toString('base64');
  }

  // 3. AES-128-CBC 路径: ★ 用 Buffer.concat 直接构建明文，避免 Array 中间层的内存膨胀
  const parts = [];
  if (includeTimestamp) {
    const tsBuf = Buffer.allocUnsafe(4);
    const hours = Math.floor((Math.floor(Date.now() / 1000) - EPOCH_2018) / 3600);
    tsBuf.writeUInt32LE(hours, 0);
    parts.push(tsBuf);
  }
  if (typeof data === 'string') {
    parts.push(Buffer.from(data));
  } else {
    parts.push(Buffer.from(data));
  }
  const plaintextBuffer = Buffer.concat(parts);

  // 原始代码: s = CryptoJS.enc.Utf8.parse(h(s))
  // h(s) 将 keyBytes 转为字符串，Utf8.parse 将字符串按 UTF-8 编码为 WordArray
  // 在 Node.js 中等价于: Buffer.from(bytesToString(keyBytes), 'utf8')
  const keyString = bytesToString(keyBytes);
  const keyBuffer = Buffer.from(keyString, 'latin1');  // 使用 latin1 编码确保逐字节映射 (binary 已废弃)
  // ★ IV=Key 协议约束，复用同一 Buffer 作为 key 和 iv（省去 16 字节拷贝）

  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, keyBuffer);
  cipher.setAutoPadding(true);  // PKCS7 padding
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  return encrypted.toString('base64');
}

/**
 * AES 解密（完全匹配企讯达客户端逻辑）
 * 
 * 原始流程:
 *   1. 用 CryptoJS.enc.Utf8.parse(h(keyBytes)) 将密钥转为 WordArray
 *   2. AES-CBC 解密，IV = Key，PKCS7 填充
 *   3. 将结果用 CryptoJS.enc.Hex 转为 hex 字符串
 *   4. 用 m() 函数将 hex 字符串转为 byte 数组
 *   5. 检查/移除时间戳
 * 
 * @param {string} base64Data - Base64 编码的密文
 * @param {string} keyStr - 密钥字符串（空字符串使用默认密钥）
 * @param {boolean} checkTimestamp - 是否验证时间戳（默认 true）
 * @returns {Buffer|null} 解密后的数据（可能已去除时间戳），失败返回 null
 */
export function aesDecrypt(base64Data, keyStr = '', checkTimestamp = true) {
  // 输入校验
  assertNonEmpty(base64Data, 'base64Data');
  assertString(base64Data, 'base64Data');
  assertString(keyStr, 'keyStr');

  // 1. 确定密钥
  let keyBytes = DEFAULT_KEY;
  if (keyStr.length > 0) {
    keyBytes = deriveKey(keyStr);
  }

  let decryptedArray;

  if (useSM4) {
    const keyArr = Array.from(keyBytes);
    const dataBytes = Buffer.from(base64Data, 'base64');
    decryptedArray = sm4.decrypt(Array.from(dataBytes), keyArr, {
      iv: keyArr,
      mode: 'cbc',
      padding: 'pkcs#5',
      output: 'array'
    });
  } else {
    // AES-128-CBC 解密
    const keyString = bytesToString(keyBytes);
    const keyBuffer = Buffer.from(keyString, 'latin1');
    // ★ IV=Key 协议约束，复用同一 Buffer（省去 16 字节拷贝）

    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, keyBuffer);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(base64Data, 'base64'), decipher.final()]);

      // ★ 直接操作 Buffer，subarray() 零拷贝，避免 Array.from 的 2x 内存往返
      if (checkTimestamp && decrypted.length > 4) {
        return Buffer.from(decrypted.subarray(4));
      }
      if (decrypted.length > 4) {
        return Buffer.from(decrypted);
      }
      return null;
    } catch (e) {
      logger.error('[Crypto] 解密失败:', e.message);
      return null;
    }
  }

  // SM4 路径：保持 Array 方式（sm-crypto 需要数组输入）
  if (!decryptedArray || decryptedArray.length === 0) {
    return null;
  }
  if (checkTimestamp && decryptedArray.length > 4) {
    return Buffer.from(decryptedArray.slice(4));
  }
  if (decryptedArray.length > 4) {
    return Buffer.from(decryptedArray);
  }
  return null;
}

/**
 * 切换到 SM4 加密模式
 */
export function enableSM4() {
  useSM4 = true;
  logger.debug('[Crypto] 已切换到 SM4 加密模式');
}

/**
 * 切换到 AES 加密模式（默认）
 */
export function disableSM4() {
  useSM4 = false;
  logger.debug('[Crypto] 已切换到 AES 加密模式');
}

/**
 * XOR 混淆（用于 will topic）
 */
export function xorObfuscate(str, key = 0x5A) {
  assertString(str, 'str');
  // ★ 用数组 collect + join，避免循环内 += 导致的 O(n²) 字符串分配
  const chars = new Array(str.length);
  for (let i = 0; i < str.length; i++) {
    chars[i] = String.fromCharCode(key ^ str.charCodeAt(i));
  }
  return chars.join('');
}

/**
 * 生成 will topic（XOR + Base64）
 */
export function generateWillTopic(node, serviceHost) {
  assertString(node, 'node');
  assertString(serviceHost, 'serviceHost');
  const combined = node + '|' + serviceHost;
  const xored = xorObfuscate(combined, 0x5A);
  return Buffer.from(xored).toString('base64');
}

/**
 * 获取默认密钥（用于调试）
 */
export function getDefaultKey() {
  return [...DEFAULT_KEY];
}

// 导出工具函数供测试使用
export const utils = {
  deriveKey,
  bytesToString,
  stringToBytes,
  bytesToHex,
  hexToBytes,
  bytesToBase64: (bytes) => Buffer.from(bytes).toString('base64'),
  base64ToBytes: (base64) => Buffer.from(base64, 'base64'),
};
