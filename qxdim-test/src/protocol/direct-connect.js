/**
 * 企讯达直连模式 — 绕过 /route，本地解密 token 并构建 MQTT 连接参数
 * 
 * 解决的问题:
 *   /route 接口在某些环境下不可用（rc=4、响应无法解密等）
 *   但 token 本身包含了所有需要的信息:
 *     - tokenPart1 (认证凭证)
 *     - tokenKey / privateSecret (AES加密密钥)
 *   只需要额外知道 MQTT 服务器地址即可直连
 * 
 * 使用场景:
 *   1. /route 不可用或被封锁
 *   2. 需要快速连接，不想走完整路由流程
 *   3. 已从浏览器提取了 MQTT 服务器地址
 */

import crypto from 'crypto';
import { aesEncrypt, aesDecrypt, generateWillTopic } from '../crypto/aes.js';
import { logger } from '../utils/logger.js';

/**
 * 本地解密 token，提取连接参数
 * 
 * @param {string} encryptedToken - localStorage 中的加密 token
 * @returns {{tokenPart1: string, tokenKey: string, privateSecret: string, mqttPassword: Buffer}}
 */
export function decryptTokenLocally(encryptedToken) {
  logger.debug('[DirectConnect] 本地解密 token...');

  // 用默认密钥解密 token
  // ★ 浏览器: AESDecrypt(token, "", false) → 第3参数n=false(废弃)
  //   第4参数o=默认true → 去掉4字节时间戳前缀
  //   对应我们的: aesDecrypt(token, '', true)
  const decryptedBuffer = aesDecrypt(encryptedToken, '', true);
  if (!decryptedBuffer) {
    throw new Error('[DirectConnect] Token 解密失败');
  }

  const decryptedStr = decryptedBuffer.toString('utf8');
  logger.debug('[DirectConnect] Token 解密成功, 长度:', decryptedStr.length);

  const parts = decryptedStr.split('|');
  if (parts.length < 2) {
    throw new Error('[DirectConnect] Token 格式错误，缺少 | 分隔符');
  }

  const tokenPart1 = parts[0];
  const tokenKey = parts[1];
  // ★ privateSecret 优先使用 UUID2（token 第三段），与 route.js/auto-login.js 保持一致
  //   服务器用 UUID2 加密 push message，若 privateSecret=tokenKey(UUID1) 会导致 push 解密失败
  const uuid2 = parts.length > 2 ? parts[2] : '';

  logger.debug('[DirectConnect] tokenPart1 长度:', tokenPart1.length);
  logger.debug('[DirectConnect] tokenKey: <redacted>');
  logger.debug('[DirectConnect] uuid2: <redacted>');

  // 构建 MQTT 密码: AESEncrypt(tokenPart1, tokenKey, true)
  const mqttPasswordBase64 = aesEncrypt(tokenPart1, tokenKey, true);
  const mqttPassword = Buffer.from(mqttPasswordBase64, 'base64');

  logger.debug('[DirectConnect] MQTT 密码构建成功, 长度:', mqttPassword.length, 'bytes');

  return {
    tokenPart1,
    tokenKey,
    privateSecret: uuid2 || tokenKey,  // ★ 优先 UUID2，无则回退 tokenKey（与 route.js 一致）
    mqttPassword,
  };
}

/**
 * 构建直连配置
 * 
 * @param {object} options
 * @param {string} options.token - 加密的 token
 * @param {string} options.mqttHost - MQTT 服务器地址
 * @param {number} options.mqttPort - MQTT 服务器端口
 * @param {string} [options.userId] - 用户ID
 * @param {string} [options.clientId] - 客户端ID
 * @param {string} [options.serviceHost] - 服务主机名
 * @param {string} [options.node] - 节点标识
 * @param {string} [options.privateSecret] - 如果已知，可跳过 token 解密
 * @param {Buffer} [options.mqttPassword] - 如果已知，可跳过密码构建
 * @returns {object} 完整的 MQTT 连接参数
 */
export function buildDirectConnectConfig(options) {
  const {
    token,
    mqttHost,
    mqttPort,
    userId = '',
    clientId = '',
    serviceHost = '',
    node = '',
  } = options;

  if (!token) {
    throw new Error('[DirectConnect] 缺少 token');
  }
  if (!mqttHost) {
    throw new Error('[DirectConnect] 缺少 mqttHost（请从浏览器提取）');
  }
  if (!mqttPort) {
    throw new Error('[DirectConnect] 缺少 mqttPort（请从浏览器提取）');
  }

  // 解密 token
  const { tokenPart1, tokenKey, privateSecret, mqttPassword } =
    options.privateSecret && options.mqttPassword
      ? (() => {
          // ★ 快速路径: 跳过 token 解密，但必须提供 userId（否则 MQTT CONNECT 会因空用户名被拒）
          if (!userId) throw new Error('[DirectConnect] 使用 privateSecret/mqttPassword 快速路径时必须提供 userId');
          return {
            tokenPart1: '',
            tokenKey: options.privateSecret,
            privateSecret: options.privateSecret,
            mqttPassword: options.mqttPassword,
          };
        })()
      : decryptTokenLocally(token);

  // 生成 clientId
  // ★ 用 crypto.randomBytes 替代 Math.random()（熵从 ~21 bit 提升到 64 bit）
  const finalClientId = clientId || `web_${Date.now()}_${crypto.randomBytes(8).toString('hex').substring(0, 8)}`;

  // 生成 will topic
  const willTopic = generateWillTopic(node || '', serviceHost || mqttHost);

  const config = {
    host: mqttHost,
    port: mqttPort || 443,
    userId: userId || tokenPart1,  // userId 可能需要另外获取
    clientId: finalClientId,
    password: mqttPassword,
    node: node || '',
    serviceHost: serviceHost || mqttHost,
    tokenKey,
    privateSecret,
    willTopic,
    useWSS: true,
  };

  logger.debug('[DirectConnect] ✅ 直连配置构建完成');
  logger.debug('[DirectConnect]   MQTT:', `wss://${config.host}:${config.port}`);
  logger.debug('[DirectConnect]   userId:', config.userId);
  logger.debug('[DirectConnect]   clientId:', config.clientId);
  logger.debug('[DirectConnect]   privateSecret 长度:', config.privateSecret.length);

  return config;
}

export default { decryptTokenLocally, buildDirectConnectConfig };
