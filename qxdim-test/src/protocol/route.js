/**
 * 企讯达路由请求模块
 * 实现获取 MQTT 服务器地址的完整流程
 *
 * 重要发现（源码逆向确认 + 浏览器抓包验证 2026-06-17）:
 * 1. RouteRequest.app 必须是 "cn.wildfirechat.chat.web"（不是 "qxdim"）
 * 2. RouteRequest.host 字段 = AES(serviceHost, DEFAULT_KEY, includeTimestamp=true)
 * 3. 路由响应有 commercial 标志位检查，bit0=1 才支持 Web
 * 4. 路由响应解密返回 null 说明是社区版（不支持Web端）
 * 5. privateSecret = UUID2（token第三段），tokenKey = UUID1（token第二段）
 *
 * ★★★ 浏览器抓包验证（2026-06-17）:
 *   - HTTP headers 必须包含: appId, appKey, p, cid, uid, Content-Type
 *   - cid/uid 加密必须 includeTimestamp=true（cid=64字符base64=48字节证实）
 *   - host 字段加密也必须 includeTimestamp=true
 *   - RouteRequest 只编码实际有值的字段，proto3 默认空字段(0/"") 不编码
 *     浏览器只发: app, platform, deviceName, phoneName, language, appVersion, sdkVersion, host
 *     不发: pushType=0, deviceVersion="", carrierName="", wxAppId="", wxAppKey="", webAppId="", webAppKey=""
 *   - IMHttpWrapper.token = cred_A (token第一段)
 *   - 请求体加密 key = UUID1 (tokenKey)
 *   - 响应体是 base64 字符串，需先 base64 解码再 [status_byte][encrypted_RouteResponse]
 */

import { aesEncrypt, aesDecrypt } from '../crypto/aes.js';
import * as proto from '../proto/index.js';
import { insecureFetch } from '../utils/http.js';
import { assertNonEmpty, assertString, assertValidUrl } from '../utils/validate.js';
import { logger } from '../utils/logger.js';

// 应用标识默认值（源码中确认的值，可通过 options 覆盖）
const DEFAULT_APP_ID = 'web_12345678';
const DEFAULT_APP_KEY = '7ed686780102b0617ae8506d4fe15224db87e5b0';

// 路由错误码映射
const ROUTE_ERROR_CODES = {
  0: '成功',
  '-1': '路由响应为空/社区版不支持Web端',
  1: '服务器内部错误',
  2: 'Token无效或已过期',
  3: '应用未授权',
  4: '频率限制',
};

/**
 * 发送路由请求，获取 MQTT 服务器连接信息
 * 
 * @param {object} options
 * @param {string} options.userId - 用户ID
 * @param {string} options.token - 加密的认证token
 * @param {string} options.clientId - 客户端ID
 * @param {string} options.proxyServer - HTTP代理服务器地址
 * @param {string} options.serviceHost - IM服务器主机名
 * @param {string} [options.appId] - 应用ID（默认 web_12345678）
 * @param {string} [options.appKey] - 应用密钥
 * @returns {Promise<{host, longPort, shortPort, wssPort, node, privateSecret, tokenKey}>}
 */
export async function requestRoute({ userId, token, clientId, proxyServer, serviceHost, appId, appKey }) {
  // 输入校验
  assertNonEmpty(userId, 'userId');
  assertString(userId, 'userId');
  assertNonEmpty(token, 'token');
  assertString(token, 'token');
  assertNonEmpty(clientId, 'clientId');
  assertString(clientId, 'clientId');
  assertNonEmpty(proxyServer, 'proxyServer');
  assertValidUrl(proxyServer, 'proxyServer');
  if (serviceHost != null && serviceHost !== '') {
    assertString(serviceHost, 'serviceHost');
  }

  logger.debug('[Route] 开始路由请求...');
  logger.debug('[Route] userId:', userId);
  logger.debug('[Route] clientId:', clientId);
  logger.debug('[Route] proxyServer:', proxyServer);

  // Step 1: 解密 token，提取 tokenPart1 和 tokenKey
  // ★★★ 关键发现（2026-06-16 实测验证）:
  //     QXDIM token 解密后格式为: "cred_A|UUID1|UUID2" (3段)
  //     - cred_A: 认证凭证（44字符base64格式）
  //     - UUID1: tokenKey（用于AES加解密的密钥，36字符UUID）
  //     - UUID2: 备用UUID（privateSecret，36字符UUID）
  //     浏览器 AESDecrypt 第4参数 o 默认 true → 去掉4字节时间戳前缀 ★★★
  logger.debug('[Route] Step 1: 解密 token...');
  const decryptedTokenBuffer = aesDecrypt(token, '', true);
  if (!decryptedTokenBuffer) {
    throw new Error('[Route] Token 解密失败');
  }
  const decryptedToken = decryptedTokenBuffer.toString('utf8');
  logger.debug('[Route] Token 解密成功, 长度:', decryptedToken.length);

  const tokenParts = decryptedToken.split('|');
  if (tokenParts.length < 2) {
    throw new Error('[Route] Token 格式错误，缺少分隔符 |');
  }

  // ★ token格式: cred_A|UUID1|UUID2 或 cred_A|UUID1
  // tokenKey = UUID1 (第二个部分)，这是 /route 请求和响应的加解密密钥
  const tokenPart1 = tokenParts[0]; // 认证凭证 (cred_A)
  const tokenKey = tokenParts[1];   // AES 加密密钥 (UUID1)
  const uuid2 = tokenParts.length > 2 ? tokenParts[2] : ''; // UUID2 (privateSecret)
  logger.debug('[Route] tokenPart1 长度:', tokenPart1.length);
  // ★ tokenKey/UUID2 是 AES 加密密钥，不输出任何部分到日志
  logger.debug('[Route] tokenKey: <redacted>');
  logger.debug('[Route] UUID2: <redacted>');

  // Step 2: 加密 clientId 和 userId（用于 HTTP 头 cid/uid）
  // ★★★ 关键: 必须带时间戳 includeTimestamp=true
  //   浏览器抓包: cid=64字符base64(=48字节) = 4字节ts + 32字节clientId明文 + 12字节PKCS7填充
  //                uid=24字符base64(=16字节) = 4字节ts + 8字节userId明文 + 4字节PKCS7填充
  //   如果用 false(不带ts), cid=44字符base64(=32字节), 与浏览器不匹配，会被服务器拒绝
  const encryptedClientId = aesEncrypt(clientId, '', true);
  const encryptedUserId = aesEncrypt(userId, '', true);
  logger.debug('[Route] Step 2: 加密 HTTP 头完成 (cid=' + encryptedClientId.length + '字符, uid=' + encryptedUserId.length + '字符)');

  // Step 3: 构造 RouteRequest Protobuf
  // ★★★ 关键: proto3 默认值(0/空字符串)不编码！
  //   浏览器抓包的 RouteRequest 只含 8 个有值字段，多余的 pushType=0/deviceVersion=""/
  //   carrierName=""/wxAppId=""/wxAppKey=""/webAppId=""/webAppKey="" 全部不编码
  //   如果显式 set 这些空字段，protobufjs 仍可能编出 tag+length=0，导致服务端校验失败
  logger.debug('[Route] Step 3: 构造 RouteRequest...');

  // ★ host 字段加密也必须 includeTimestamp=true（与 cid/uid 一致）
  const encryptedServiceHost = serviceHost ? aesEncrypt(serviceHost, '', true) : '';
  logger.debug('[Route] serviceHost 加密后长度:', encryptedServiceHost.length);

  // 只设置浏览器实际发送的字段（其它字段全部留空 → proto3 不编码）
  const routeRequestPayload = {
    app: 'cn.wildfirechat.chat.web',  // 必须是 WildFireChat 包名
    platform: 5,                       // 5=Web (SDK_PLATFORM_WEB)
    deviceName: 'browser',
    phoneName: 'browser',
    language: 'zh_CN',                 // 下划线不是横线
    appVersion: '0.1',
    sdkVersion: '0.1',
    host: encryptedServiceHost,         // AES加密后的 serviceHost (带时间戳)
    // 以下字段在浏览器抓包中不存在，禁止设置:
    //   pushType=0, deviceVersion="", carrierName="",
    //   wxAppId="", wxAppKey="", webAppId="", webAppKey=""
  };

  const routeRequestBytes = proto.encode('qxdim.RouteRequest', routeRequestPayload);
  logger.debug('[Route] RouteRequest 编码完成, 大小:', routeRequestBytes.length, 'bytes');

  // Step 4: 构造 IMHttpWrapper
  const wrapperPayload = {
    token: tokenPart1,
    clientId: clientId,
    request: 'ROUTE',
    data: routeRequestBytes,
  };

  const wrapperBytes = proto.encode('qxdim.IMHttpWrapper', wrapperPayload);

  // Step 5: 用 tokenKey 加密整个请求体
  const encryptedBody = aesEncrypt(wrapperBytes, tokenKey, true);
  logger.debug('[Route] Step 4: 请求体加密完成, 大小:', encryptedBody.length);

  // Step 6: 构造 MQTT 连接密码
  const mqttPassword = Buffer.from(aesEncrypt(tokenPart1, tokenKey, true), 'base64');

  // Step 7: 发送 HTTP POST 请求
  logger.debug('[Route] Step 5: 发送路由请求到:', proxyServer + '/route');
  const response = await insecureFetch(proxyServer + '/route', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'appId': appId || DEFAULT_APP_ID,
      'appKey': appKey || DEFAULT_APP_KEY,
      'cid': encryptedClientId,
      'uid': encryptedUserId,
      'p': 'web',
    },
    body: encryptedBody,
    timeout: 20000,
    insecure: true,  // proxyServer(appServer) 可能使用自签名证书
  });

  if (!response.ok) {
    throw new Error(`[Route] HTTP ${response.status}: ${await response.text()}`);
  }

  const responseBody = await response.buffer();

  if (!responseBody || responseBody.length < 2) {
    throw new Error('[Route] 路由响应为空（服务器可能不可达或返回了空内容）');
  }

  // Step 8: 解密响应
  // ★★★ 关键发现: QXDIM 的 /route 响应体是 base64 编码的字符串，不是原始二进制！★★★
  // Content-Type: application/octet-stream，但实际内容是 base64 ASCII 文本
  // 需要先 base64 解码，才能得到 [status_byte][encrypted_RouteResponse]
  logger.debug('[Route] Step 6: 解密路由响应...');
  logger.debug('[Route] 原始响应大小:', responseBody.length, 'bytes');
  // ★ subarray 只取前 64 字节做 hex 转储，避免整个响应体转 hex 的内存浪费
  if (logger.isDebugEnabled()) {
    logger.debug('[Route] 原始响应(hex前64字节):', responseBody.subarray(0, 64).toString('hex'));
  }

  // ★ 判断响应体格式：可能是 base64 字符串，也可能是原始二进制
  // 如果第一个字节的 ASCII 值 > 2（不是有效的状态码），说明是 base64 编码的字符串
  let responseData = responseBody;
  if (responseBody[0] > 2) {
    // 第一个字节不是有效状态码，尝试 base64 解码
    try {
      const decoded = Buffer.from(responseBody.toString('ascii'), 'base64');
      logger.debug('[Route] 检测到 base64 编码响应，解码后:', decoded.length, 'bytes');
      responseData = decoded;
    } catch(e) {
      logger.warn('[Route] base64 解码失败，尝试按原始二进制处理');
    }
  }

  const statusByte = responseData[0];
  logger.debug('[Route] 状态码:', statusByte, statusByte === 0 ? '(成功)' : `(错误: ${ROUTE_ERROR_CODES[statusByte] || '未知'})`);

  // ★ 源码中的关键检查: 状态码必须为0
  if (statusByte !== 0) {
    const errorDesc = ROUTE_ERROR_CODES[statusByte] || `未知错误码 ${statusByte}`;
    logger.error('[Route] ❌ 路由请求失败:', errorDesc);
    logger.error('[Route] 可能原因:');
    logger.error('  1. Token 已过期');
    logger.error('  2. 应用未被授权 (appId/appKey 不匹配)');
    logger.error('  3. IM 服务器不可达');
    throw new Error(`[Route] 路由请求被拒绝: ${errorDesc} (code=${statusByte})`);
  }

  if (responseData.length < 2) {
    throw new Error('[Route] 路由响应体过短，无有效数据');
  }

  const encryptedResponse = responseData.slice(1).toString('base64');
  const decryptedResponse = aesDecrypt(encryptedResponse, tokenKey, true);
  if (!decryptedResponse) {
    // ★ 源码中的提示: 解密返回null说明是社区版，不支持Web端
    logger.error('[Route] ❌ 路由响应解密返回 null');
    logger.error('[Route] 这通常意味着:');
    logger.error('  所部署的 IM-Server 是社区版，不支持 Web 端接入！');
    logger.error('  要专业版 IM-Server 才支持 Web 端接入!!!');
    throw new Error('[Route] 路由响应解密失败 — 可能是社区版IM服务器不支持Web端');
  }

  // Step 9: Protobuf 解码路由响应
  const routeResponse = proto.decode('qxdim.RouteResponse', decryptedResponse);
  const routeData = proto.toJSON(routeResponse);

  logger.debug('[Route] === 路由响应 ===');
  logger.debug('[Route] MQTT Host:', routeData.host);
  logger.debug('[Route] Long Port:', routeData.longPort);
  logger.debug('[Route] Short Port:', routeData.shortPort);
  logger.debug('[Route] WSS Port:', routeData.wssPort);
  logger.debug('[Route] Node:', routeData.node);
  logger.debug('[Route] Commercial:', routeData.commercial, `(bit0=${routeData.commercial & 1})`);
  if (routeData.candidate && routeData.candidate.length > 0) {
    logger.debug('[Route] 候选地址:', JSON.stringify(routeData.candidate));
  }

  // ★ 源码中的关键检查: commercial bit0 必须为1才支持Web端
  if (!(routeData.commercial & 1)) {
    logger.error('[Route] ❌ commercial 标志位 bit0=0，IM服务器不支持Web端接入');
    logger.error('[Route] commercial =', routeData.commercial, '需要 bit0=1 (值为奇数)');
    throw new Error('[Route] IM服务器不支持Web端 (commercial标志位不满足)');
  }

  // ★ 根据源码确定WSS端口选择逻辑
  let wssPort;
  if (routeData.commercial & 8) {
    // commercial bit3=1 时使用 wssPort
    wssPort = routeData.wssPort || 443;
    logger.debug('[Route] 使用 wssPort (commercial bit3=1):', wssPort);
  } else {
    // 否则使用 longPort
    wssPort = routeData.longPort || 443;
    logger.debug('[Route] 使用 longPort (commercial bit3=0):', wssPort);
  }

  return {
    host: routeData.host,
    longPort: routeData.longPort,
    shortPort: routeData.shortPort,
    wssPort: wssPort,
    node: routeData.node,
    commercial: routeData.commercial,
    candidate: routeData.candidate || [],
    tokenKey: tokenKey,
    tokenPart1: tokenPart1,
    uuid2: uuid2,
    mqttPassword: mqttPassword,
    // ★ privateSecret 优先使用 UUID2，无则用 tokenKey
    privateSecret: uuid2 || tokenKey,
  };
}
