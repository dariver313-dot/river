/**
 * 企讯达 (QXDIM) SDK - 主入口
 *
 * 统一导出所有公开 API:
 *   - 加密: aesEncrypt, aesDecrypt, generateWillTopic, ...
 *   - Proto: initProto, encode, decode, toJSON
 *   - 协议: autoLogin, requestRoute, buildDirectConnectConfig, QXDimClient, ConnectionStatus
 *   - 工具: parseMessageContent, formatMessageContent, ContentType, MediaType, PersistFlag
 *   - ★ 高级 SDK: QXDim (推荐新代码用这个)
 *
 * 用法:
 *   import { QXDim } from './src/index.js';
 *   const qxd = new QXDim();
 *   await qxd.login('your_company_code', '+86 13800000000', 'your_password');
 *   qxd.onMessage((msg) => console.log('收到:', msg.text));
 *   await qxd.sendText('88dv45ixr', 'Hello!');
 *
 * 端到端示例见 examples/sdk-demo.js
 */

// ★ 高级 SDK (推荐新代码用)
export { QXDim } from './qxdim.js';

// ★ .env 文件加载器
export { loadEnv } from './env-loader.js';

// 加密模块
export {
  aesEncrypt,
  aesDecrypt,
  enableSM4,
  disableSM4,
  xorObfuscate,
  generateWillTopic,
  getDefaultKey,
  utils,
} from './crypto/aes.js';

// Proto 编解码
export { initProto, getType, encode, decode, toJSON } from './proto/index.js';

// 协议层
export { requestRoute } from './protocol/route.js';
export { QXDimClient, ConnectionStatus } from './protocol/mqtt-client.js';
export { decryptTokenLocally, buildDirectConnectConfig } from './protocol/direct-connect.js';
export {
  loginWithPassword,
  loginWithCode,
  sendSmsCode,
  generateSlideVerify,
  encryptRawToken,
  parseRawToken,
  parseEncryptedToken,
  autoLogin,
} from './protocol/auto-login.js';
export { ensureMqttPatched, decryptMqttResponse } from './protocol/wfc-mqtt-patch.js';
export {
  loadSession,
  saveSession,
  clearSession,
  listSessions,
  isSessionValid,
  normalizeMobile,
  getSessionPath,
} from './protocol/session-store.js';
// 完整登录流程的各个阶段（高级用户可单独调用）
export { resolveCompanyAppServers } from './protocol/company-resolve.js';
export { queryCompanyServer } from './protocol/company-server.js';
export { getPcSession } from './protocol/pc-session.js';
export { sessionLogin } from './protocol/session-login.js';
export { checkTokenReady } from './protocol/token-health.js';
export {
  uploadMedia,
  uploadFromConnectParams,
  MediaType as OSSMediaType,
  inferMediaType,
  extractOssEndpoint,
  extractOssBucket,
  generateObjectKey,
} from './protocol/media-upload.js';

// 消息解析工具
export {
  parseMessageContent,
  formatMessageContent,
  getContentTypeName,
  ContentType,
  MediaType,
  PersistFlag,
} from './utils/message-parser.js';

// ★ AI 自动回复
export { chatCompletion, chat } from './ai/deepseek-client.js';
export { ConversationStore } from './ai/conversation-store.js';
export { AutoReplyBot } from './ai/auto-reply.js';

