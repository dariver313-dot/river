/**
 * 企讯达自动登录模块
 * 
 * 完整链路（无需手动从浏览器复制 token）:
 *   手机号+密码 → /login_pwd API → 拿到 userId + rawToken
 *   → rawToken 用默认密钥 AES 加密 → 等同浏览器 localStorage 中的 token
 *   → 本地解密提取 tokenPart1 + tokenKey
 *   → 尝试 /route 获取 MQTT 地址（成功则用路由模式）
 *   → /route 失败则用直连模式（需要配置 mqttHost/mqttPort）
 *   → MQTT 连接 → 消息收发
 * 
 * WildFireChat app-server 登录 API（源码确认）:
 *   POST /login_pwd  {mobile, password, clientId, platform, slideVerifyToken?}
 *   POST /login      {mobile, code, clientId, platform, slideVerifyToken?}
 *   返回: {code:0, result:{userId, token, userName, portrait, register}}
 *   其中 token = IM-Server 返回的 "credential|UUID" (tokenPart1|tokenKey)
 *   HTTP 响应头还包含 authToken (Shiro session ID)
 */

import crypto from 'crypto';
import { aesEncrypt, aesDecrypt } from '../crypto/aes.js';
import { requestRoute } from './route.js';
import { buildDirectConnectConfig } from './direct-connect.js';
import { resolveCompanyAppServers } from './company-resolve.js';
import { queryCompanyServer } from './company-server.js';
import { loadSession, isSessionValid, clearSession, saveSession } from './session-store.js';
import { getPcSession } from './pc-session.js';
import { sessionLogin } from './session-login.js';
import { insecureFetch, USER_AGENT } from '../utils/http.js';
import { logger } from '../utils/logger.js';

// ==================== 登录 API ====================

/**
 * 使用手机号+密码登录
 * 
 * @param {object} options
 * @param {string} options.mobile - 手机号
 * @param {string} options.password - 密码
 * @param {string} options.appServer - app-server 地址 (如 https://app.qixunda.tech)
 * @param {string} [options.clientId] - 客户端ID（可选，自动生成）
 * @param {number} [options.platform=5] - 平台编号 (5=Web)
 * @param {string} [options.slideVerifyToken] - 滑动验证码 token（如果服务器要求）
 * @returns {Promise<{userId: string, token: string, authToken: string, userName: string, portrait: string, register: boolean}>}
 */
export async function loginWithPassword({ mobile, password, appServer, clientId, platform = 5, slideVerifyToken, pcSessionToken }) {
  logger.debug('[AutoLogin] 使用密码登录...');
  logger.debug('[AutoLogin] appServer:', appServer);
  logger.debug('[AutoLogin] mobile:', mobile.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'));

  if (!mobile || !password || !appServer) {
    throw new Error('[AutoLogin] 缺少必要参数: mobile, password, appServer');
  }

  const body = {
    mobile,
    password,
    clientId: clientId || generateClientId(),
    platform,
  };

  // 滑动验证码（可选）
  if (slideVerifyToken) {
    body.slideVerifyToken = slideVerifyToken;
  }

  // ★ 抓包确认: /login_pwd 需要带 /pc_session 返回的预会话 token
  //   服务器当前不强制校验，但按客户端行为完整还原
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'app://.',
    'User-Agent': USER_AGENT,
  };
  if (pcSessionToken) {
    headers['authToken'] = pcSessionToken;
    logger.debug('[AutoLogin] 携带 pcSession token: <redacted>');
  }

  const response = await sendJsonRequest(`${appServer}/login_pwd`, body, headers);
  
  if (response.code !== 0) {
    const errorMap = {
      1: '服务器内部错误',
      2: '验证码/密码错误',
      3: '用户不存在',
      4: '频率限制',
      5: '滑动验证未通过',
      6: '用户已被封禁',
      7: '密码错误次数过多，请5分钟后重试',
      8: '密码过弱',
      9: '注册被禁止',
    };
    const errMsg = errorMap[response.code] || `未知错误码 ${response.code}`;
    throw new Error(`[AutoLogin] 登录失败: ${errMsg} (code=${response.code}, msg=${response.message || ''})`);
  }

  const result = response.result;
  logger.debug('[AutoLogin] ✅ /login API 返回成功');
  logger.debug('[AutoLogin]   userId:', result.userId);
  logger.debug('[AutoLogin]   userName:', result.userName || '(未设置)');
  logger.debug('[AutoLogin]   register:', result.register ? '新用户' : '老用户');
  logger.debug('[AutoLogin]   token 长度:', result.token?.length || 0);

  return {
    userId: result.userId,
    token: result.token,           // rawToken: "credential|UUID" (明文，未加密)
    authToken: response.authToken,  // Shiro session ID（从响应头获取）
    userName: result.userName,
    portrait: result.portrait,
    register: result.register,
    resetCode: result.resetCode,
  };
}

/**
 * 使用手机号+验证码登录
 * 
 * @param {object} options
 * @param {string} options.mobile - 手机号
 * @param {string} options.code - 短信验证码
 * @param {string} options.appServer - app-server 地址
 * @param {string} [options.clientId] - 客户端ID
 * @param {number} [options.platform=5] - 平台编号
 * @param {string} [options.slideVerifyToken] - 滑动验证码 token
 * @returns {Promise<object>} 同 loginWithPassword 返回值
 */
export async function loginWithCode({ mobile, code, appServer, clientId, platform = 5, slideVerifyToken }) {
  logger.debug('[AutoLogin] 使用验证码登录...');
  logger.debug('[AutoLogin] appServer:', appServer);
  logger.debug('[AutoLogin] mobile:', mobile.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'));

  if (!mobile || !code || !appServer) {
    throw new Error('[AutoLogin] 缺少必要参数: mobile, code, appServer');
  }

  const body = {
    mobile,
    code,
    clientId: clientId || generateClientId(),
    platform,
  };

  if (slideVerifyToken) {
    body.slideVerifyToken = slideVerifyToken;
  }

  const response = await sendJsonRequest(`${appServer}/login`, body);

  if (response.code !== 0) {
    throw new Error(`[AutoLogin] 登录失败: code=${response.code}, msg=${response.message || ''}`);
  }

  const result = response.result;
  logger.debug('[AutoLogin] ✅ /login API 返回成功');
  logger.debug('[AutoLogin]   userId:', result.userId);

  return {
    userId: result.userId,
    token: result.token,
    authToken: response.authToken,
    userName: result.userName,
    portrait: result.portrait,
    register: result.register,
    resetCode: result.resetCode,
  };
}

/**
 * 发送短信验证码
 * 
 * @param {object} options
 * @param {string} options.mobile - 手机号
 * @param {string} options.appServer - app-server 地址
 * @param {string} [options.slideVerifyToken] - 滑动验证码 token
 * @returns {Promise<boolean>} 是否发送成功
 */
export async function sendSmsCode({ mobile, appServer, slideVerifyToken }) {
  logger.debug('[AutoLogin] 发送验证码到:', mobile.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'));

  const body = { mobile };
  if (slideVerifyToken) {
    body.slideVerifyToken = slideVerifyToken;
  }

  const response = await sendJsonRequest(`${appServer}/send_code`, body);
  
  if (response.code !== 0) {
    throw new Error(`[AutoLogin] 发送验证码失败: code=${response.code}, msg=${response.message || ''}`);
  }

  logger.debug('[AutoLogin] ✅ 验证码已发送');
  return true;
}

/**
 * 获取滑动验证码
 * 
 * @param {string} appServer - app-server 地址
 * @returns {Promise<{token: string, backgroundImage: string, sliderImage: string}>}
 */
export async function generateSlideVerify(appServer) {
  logger.debug('[AutoLogin] 获取滑动验证码...');

  const response = await sendJsonRequest(`${appServer}/slide_verify/generate`, {});

  if (response.code !== 0) {
    throw new Error(`[AutoLogin] 获取滑动验证码失败: code=${response.code}`);
  }

  return response.result;
}

// ==================== Token 处理 ====================

/**
 * 将登录 API 返回的 rawToken 加密为浏览器 localStorage 中的格式
 * 
 * 浏览器流程:
 *   1. 登录 API 返回 token = "credential|UUID"（明文）
 *   2. AESEncrypt(token, DEFAULT_KEY, true) → 加密的 Base64
 *   3. localStorage.setItem("token", encryptedBase64)
 * 
 * @param {string} rawToken - 登录 API 返回的明文 token（"credential|UUID"）
 * @returns {string} 加密后的 token（等同于 localStorage 中的值）
 */
export function encryptRawToken(rawToken) {
  logger.debug('[AutoLogin] 加密 rawToken...');
  const encrypted = aesEncrypt(rawToken, '', true);
  logger.debug('[AutoLogin] 加密后 token 长度:', encrypted.length);
  return encrypted;
}

/**
 * 从 rawToken（明文）直接提取 tokenPart1 和 tokenKey
 * 
 * @param {string} rawToken - 登录 API 返回的 "credential|UUID" 
 * @returns {{tokenPart1: string, tokenKey: string, privateSecret: string, mqttPassword: Buffer}}
 */
export function parseRawToken(rawToken) {
  logger.debug('[AutoLogin] 解析 rawToken...');
  
  const parts = rawToken.split('|');
  if (parts.length < 2) {
    throw new Error('[AutoLogin] rawToken 格式错误，缺少 | 分隔符');
  }

  // ★ Token 格式: "cred_A|UUID1|UUID2" (3段)
  // cred_A = 认证凭证, UUID1 = tokenKey, UUID2 = privateSecret
  const tokenPart1 = parts[0]; // cred_A
  const tokenKey = parts[1];   // UUID1 (加解密密钥)
  const uuid2 = parts.length > 2 ? parts[2] : ''; // UUID2 (privateSecret)

  logger.debug('[AutoLogin] tokenPart1 长度:', tokenPart1.length);
  logger.debug('[AutoLogin] tokenKey: <redacted>');
  logger.debug('[AutoLogin] UUID2: <redacted>');

  // 构建 MQTT 密码: AESEncrypt(tokenPart1, tokenKey, true) → Base64 → Buffer
  const mqttPasswordBase64 = aesEncrypt(tokenPart1, tokenKey, true);
  const mqttPassword = Buffer.from(mqttPasswordBase64, 'base64');

  logger.debug('[AutoLogin] MQTT 密码构建成功, 长度:', mqttPassword.length, 'bytes');

  return {
    tokenPart1,
    tokenKey,
    uuid2,
    privateSecret: uuid2 || tokenKey,
    mqttPassword,
  };
}

/**
 * 从加密 token（localStorage 格式）提取连接参数
 * 
 * @param {string} encryptedToken - AES 加密后的 token
 * @returns {{tokenPart1: string, tokenKey: string, privateSecret: string, mqttPassword: Buffer}}
 */
export function parseEncryptedToken(encryptedToken) {
  logger.debug('[AutoLogin] 从加密 token 提取参数...');
  
  const decryptedBuffer = aesDecrypt(encryptedToken, '', true);
  if (!decryptedBuffer) {
    throw new Error('[AutoLogin] Token 解密失败');
  }

  const rawToken = decryptedBuffer.toString('utf8');
  return parseRawToken(rawToken);
}

// ==================== 完整自动连接 ====================

/**
 * 一键自动登录并获取 MQTT 连接参数
 *
 * 完整流程 (按浏览器抓包还原):
 *   0. (可选) 企业 ID 解析: companyCode → DNS TXT → /query_company_server → 拿到 appServerHost + imServerHost
 *   1. /pc_session 拿预会话 token (5分钟有效)
 *   2. /login_pwd (带 authToken 头) 拿 userId + 加密 token
 *   3. 解密 token → tokenPart1 + tokenKey + privateSecret
 *   4. /route 拿 MQTT 服务器地址
 *   5. 返回完整 MQTT 连接参数
 *
 * 两种使用方式:
 *
 *   方式 A (推荐，新代码): 只传 companyCode + mobile + password
 *     autoLogin({ companyCode: 'your_company_code', mobile: '+86 xxx', password: 'xxx' })
 *     → 自动跑步骤 0-5
 *
 *   方式 B (兼容旧代码): 直接传 appServer + serviceHost + proxyServer
 *     autoLogin({ mobile, password, appServer, serviceHost, proxyServer })
 *     → 跳过步骤 0，从步骤 1 开始
 *
 * @param {object} options
 * @param {string} [options.companyCode] - 企业 ID (如 "your_company_code")，传入则自动解析
 * @param {string} options.mobile - 手机号
 * @param {string} options.password - 密码
 * @param {string} [options.appServer] - 已知的 app-server 地址（跳过企业 ID 解析）
 * @param {string} [options.serviceHost] - 已知的 IM 服务器主机名
 * @param {string} [options.proxyServer] - 已知的代理地址（/route 用，默认同 appServer）
 * @param {object} [options.directConnect] - 直连参数（/route 不可用时使用）
 * @param {string} [options.directConnect.mqttHost] - MQTT 服务器地址
 * @param {number} [options.directConnect.mqttPort] - MQTT 服务器端口
 * @param {string} [options.directConnect.node] - 节点标识
 * @param {string} [options.clientId] - 客户端ID
 * @param {number} [options.platform=5] - 平台编号
 * @param {boolean} [options.preferRoute=true] - 是否优先尝试 /route
 * @param {boolean} [options.useCache=true] - 是否使用本地 session 缓存
 * @param {boolean} [options.relogin=false] - 强制重新登录（忽略缓存）
 * @param {boolean} [options.saveCache=true] - 登录成功后是否写入缓存
 * @param {boolean} [options.usePcSession=true] - 是否调用 /pc_session 获取预会话 token
 * @returns {Promise<{userId, clientId, host, port, password, node, serviceHost, tokenKey, privateSecret, willTopic, useWSS, encryptedToken, companyInfo}>}
 */
export async function autoLogin(options) {
  const {
    companyCode,
    mobile,
    password,
    appServer: providedAppServer,
    serviceHost: providedServiceHost,
    proxyServer: providedProxyServer,
    directConnect = {},
    clientId: providedClientId,
    platform = 5,
    preferRoute = true,
    useCache = true,
    relogin = false,
    saveCache = true,
    usePcSession = true,
  } = options;

  logger.debug('\n╔══════════════════════════════════════════════╗');
  logger.debug('║   企讯达自动登录                              ║');
  logger.debug('╚══════════════════════════════════════════════╝\n');

  // ========== Step -1: 企业 ID 解析 (如果传了 companyCode 且未提供 appServer) ==========
  let appServer = providedAppServer;
  let serviceHost = providedServiceHost;
  let proxyServer = providedProxyServer || providedAppServer;
  let companyInfo = null;

  if (companyCode && !appServer) {
    logger.debug('━━━ Step -1: 企业 ID 解析 ━━━');
    logger.debug(`[AutoLogin] companyCode: ${companyCode}`);
    const candidates = await resolveCompanyAppServers(companyCode);
    companyInfo = await queryCompanyServer(companyCode, candidates);

    appServer = companyInfo.appServerHost;
    // imServerHost 形如 "https://qim1.qixunda.tech"，提取主机名
    if (companyInfo.imServerHost) {
      serviceHost = companyInfo.imServerHost.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
    proxyServer = appServer;  // /route 与 /login_pwd 同一个 appServer
    logger.debug(`[AutoLogin]   appServerHost : ${appServer}`);
    logger.debug(`[AutoLogin]   serviceHost   : ${serviceHost}`);
    logger.debug(`[AutoLogin]   proxyServer   : ${proxyServer}`);
  }

  if (!appServer) {
    throw new Error('[AutoLogin] 必须提供 companyCode 或 appServer 之一');
  }

  // ========== Step 0: 尝试从缓存加载 session ==========
  // 缓存命中时跳过 /pc_session + /login_pwd（避免旧 token 失效 + 避免多端互踢）
  let cachedSession = null;
  if (useCache && !relogin && mobile) {
    cachedSession = await loadSession(mobile);
    if (cachedSession && isSessionValid(cachedSession)) {
      logger.debug(`[AutoLogin] 📦 命中本地缓存: userId=${cachedSession.userId} clientId=${cachedSession.clientId}`);
      logger.debug(`[AutoLogin]   跳过 /pc_session + /login_pwd，直接走 /route`);
      // 缓存里如果有 appServer/serviceHost 用缓存的（避免每次都跑企业 ID 解析）
      if (cachedSession.appServer) appServer = cachedSession.appServer;
      if (cachedSession.serviceHost) serviceHost = cachedSession.serviceHost;
      if (cachedSession.proxyServer) proxyServer = cachedSession.proxyServer;
    } else {
      // ★ 缓存过期或无效: 清除旧文件，走正常登录流程
      if (cachedSession) {
        logger.debug(`[AutoLogin] ⏰ 缓存已过期，清除旧 session 并重新登录...`);
        await clearSession(mobile);
      }
      cachedSession = null;
    }
  }

  // ========== Step 1: 登录 API (或从缓存复用) ==========
  let userId, rawToken, encryptedToken, clientId, loginResult;
  let tokenPart1, tokenKey, privateSecret, mqttPassword;

  if (cachedSession) {
    // ★ 复用缓存：用保存的 clientId + token，跳过 /pc_session + /login_pwd
    userId = cachedSession.userId;
    clientId = cachedSession.clientId;
    encryptedToken = cachedSession.encryptedToken;
    tokenPart1 = cachedSession.tokenPart1;
    tokenKey = cachedSession.tokenKey;
    privateSecret = cachedSession.privateSecret;
    loginResult = cachedSession.loginResult || null;

    // 重新计算 mqttPassword（动态构建，不持久化）
    const mqttPasswordBase64 = aesEncrypt(tokenPart1, tokenKey, true);
    mqttPassword = Buffer.from(mqttPasswordBase64, 'base64');

    logger.debug(`[AutoLogin]   userId: ${userId}`);
    logger.debug(`[AutoLogin]   userName: ${cachedSession.userName || '(unknown)'}`);
    logger.debug(`[AutoLogin]   token: (cached, len=${encryptedToken.length})`);
  } else {
    // ★ 正常登录流程
    clientId = providedClientId || generateClientId();

    // Step 1a: /pc_session 拿预会话 token
    let pcSessionToken = null;
    if (usePcSession) {
      logger.debug('\n━━━ Step 1a: /pc_session 获取预会话 token ━━━');
      const psResult = await getPcSession({ appServerHost: appServer, clientId, platform });
      pcSessionToken = psResult.token;

      // Step 1a-2: /session_login/<token> 激活预会话 (按浏览器抓包完整还原)
      logger.debug('\n━━━ Step 1a-2: /session_login/<token> 激活会话 ━━━');
      await sessionLogin({
        appServerHost: appServer,
        pcSessionToken,
        cookie: psResult.cookie,
      });
    }

    // Step 1b: /login_pwd (带 authToken 头)
    logger.debug('\n━━━ Step 1b: /login_pwd 登录 ━━━');
    loginResult = await loginWithPassword({
      mobile,
      password,
      appServer,
      clientId,
      platform,
      pcSessionToken,
    });

    ({ userId, token: rawToken } = loginResult);

    // ========== Step 2: 解析 Token ==========
    logger.debug('\n━━━ Step 2: 解析 Token ━━━');
    // ★ 用 split 一次完成判断+分解，避免 includes+split 双重扫描
    const tokenParts = rawToken.split('|');
    if (tokenParts.length >= 2) {
      ({ tokenPart1, tokenKey, privateSecret, mqttPassword } = parseRawToken(rawToken));
      encryptedToken = encryptRawToken(rawToken);
    } else {
      logger.debug('[AutoLogin] 检测到 token 已加密（不含 "|" 分隔符），直接解密提取参数...');
      ({ tokenPart1, tokenKey, privateSecret, mqttPassword } = parseEncryptedToken(rawToken));
      encryptedToken = rawToken;
    }
  }

  // ========== Step 3: 获取 MQTT 连接参数 ==========
  logger.debug('\n━━━ Step 3: 获取 MQTT 连接参数 ━━━');
  
  let connectParams;

  if (preferRoute && proxyServer) {
    // 优先尝试 /route
    logger.debug('[AutoLogin] 尝试 /route 获取 MQTT 地址...');
    try {
      const routeResult = await requestRoute({
        userId,
        token: encryptedToken,
        clientId,
        proxyServer,
        serviceHost,
      });

      connectParams = {
        host: routeResult.host,
        port: routeResult.wssPort || 443,
        userId,
        clientId,
        password: routeResult.mqttPassword || mqttPassword,
        node: routeResult.node,
        serviceHost: serviceHost || routeResult.host,
        tokenKey,
        privateSecret,
        useWSS: true,
      };

      logger.debug('[AutoLogin] ✅ /route 成功，使用路由模式');
    } catch (routeErr) {
      logger.warn('[AutoLogin] ⚠️ /route 失败:', routeErr.message);
      logger.debug('[AutoLogin] 切换到直连模式...');
      connectParams = null;
    }
  }

  if (!connectParams) {
    // 直连模式
    if (!directConnect.mqttHost) {
      throw new Error(
        '[AutoLogin] /route 不可用且未配置直连参数。\n' +
        '请在 config.js 中配置 autoLogin.directConnect.mqttHost 和 mqttPort，\n' +
        '或确保 /route 端点可用。'
      );
    }

    connectParams = buildDirectConnectConfig({
      token: encryptedToken,
      mqttHost: directConnect.mqttHost,
      mqttPort: directConnect.mqttPort,
      userId,
      clientId,
      serviceHost,
      node: directConnect.node || '',
      privateSecret,
      mqttPassword,
    });
    
    logger.debug('[AutoLogin] ✅ 使用直连模式');
  }

  // 添加额外信息
  connectParams.encryptedToken = encryptedToken;
  connectParams.rawToken = rawToken || encryptedToken;  // 缓存路径下 rawToken 可能未设置
  connectParams.loginResult = loginResult;

  // ========== Step 4: 保存 session 到本地缓存 ==========
  if (saveCache && mobile) {
    try {
      await saveSession(mobile, {
        userId,
        userName: loginResult?.userName || cachedSession?.userName || '',
        clientId,
        encryptedToken,
        tokenPart1,
        tokenKey,
        privateSecret,
        host: connectParams.host,
        port: connectParams.port,
        node: connectParams.node,
        serviceHost: connectParams.serviceHost,
        // ★ 保存企业 ID 解析得到的服务器地址，下次直接复用
        appServer,
        proxyServer,
        companyCode: companyCode || cachedSession?.companyCode || null,
        companyInfo: companyInfo || cachedSession?.companyInfo || null,
        loginResult: loginResult ? {
          userId: loginResult.userId,
          userName: loginResult.userName,
          portrait: loginResult.portrait,
          register: loginResult.register,
        } : null,
      });
    } catch (e) {
      logger.warn('[AutoLogin] 保存 session 失败:', e.message);
    }
  }

  // 把 companyInfo 也返回给上层
  connectParams.companyInfo = companyInfo || cachedSession?.companyInfo || null;
  connectParams.appServer = appServer;
  connectParams.companyCode = companyCode || cachedSession?.companyCode || null;

  logger.debug('\n━━━ 自动登录完成 ━━━');
  logger.debug('[AutoLogin] MQTT:', `wss://${connectParams.host}:${connectParams.port}`);
  logger.debug('[AutoLogin] userId:', connectParams.userId);
  logger.debug('[AutoLogin] clientId:', connectParams.clientId);
  logger.debug('[AutoLogin] privateSecret 长度:', connectParams.privateSecret.length);

  return connectParams;
}

// ==================== 工具函数 ====================

/**
 * 生成客户端 ID
 * 格式参考 WFC SDK: web_ + 时间戳 + 随机字符串
 */
function generateClientId() {
  // ★ 用 crypto.randomBytes 替代 Math.random()：熵从 ~27 bit 提升到 64 bit
  return `web_${Date.now()}_${crypto.randomBytes(8).toString('hex').substring(0, 8)}`;
}

/**
 * 发送 JSON HTTP 请求
 *
 * @param {string} url - 请求 URL
 * @param {object} body - 请求体对象
 * @param {object} [extraHeaders] - 额外请求头 (如 authToken)
 * @returns {Promise<{code, message, result, authToken}>}
 */
async function sendJsonRequest(url, body, extraHeaders = {}) {
  const response = await insecureFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    timeout: 20000,
    insecure: true,  // appServer 可能使用自签名证书
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  // 提取 authToken（Shiro session ID）从响应头
  json.authToken = response.headers.get('authtoken') || '';
  return json;
}

export default {
  loginWithPassword,
  loginWithCode,
  sendSmsCode,
  generateSlideVerify,
  encryptRawToken,
  parseRawToken,
  parseEncryptedToken,
  autoLogin,
};
