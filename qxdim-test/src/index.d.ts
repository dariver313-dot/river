// 让相对路径 import { ... } from '../src/index.js' 自动找到类型
// 通过 re-export types/index.d.ts 的所有类型定义
//
// 注意: class、enum、const 是 value（用 export），interface、type 是 type（用 export type）

// Classes (values)
export { QXDim, QXDimClient } from '../types/index.d.ts';

// Enums (values)
export {
  ConnectionStatus,
  ConversationType,
  ContentType,
  MediaType,
  PersistFlag,
} from '../types/index.d.ts';

// Constants (values)
export { utils } from '../types/index.d.ts';
// OSSMediaType — 用于 OSS 上传的媒体类型枚举（与 MediaType 独立）
export { OSSMediaType } from '../types/index.d.ts';

// Functions (values)
export {
  resolveCompanyAppServers,
  queryCompanyServer,
  getPcSession,
  sessionLogin,
  checkTokenReady,
  uploadMedia,
  uploadFromConnectParams,
  inferMediaType,
  extractOssEndpoint,
  extractOssBucket,
  generateObjectKey,
  loginWithPassword,
  requestRoute,
  autoLogin,
  normalizeMobile,
  getSessionPath,
  loadSession,
  saveSession,
  clearSession,
  listSessions,
  isSessionValid,
  aesEncrypt,
  aesDecrypt,
  generateWillTopic,
  xorObfuscate,
  getDefaultKey,
  enableSM4,
  disableSM4,
  initProto,
  getType,
  encode,
  decode,
  toJSON,
  parseMessageContent,
  formatMessageContent,
  getContentTypeName,
  decryptTokenLocally,
  buildDirectConnectConfig,
  encryptRawToken,
  parseRawToken,
  parseEncryptedToken,
  ensureMqttPatched,
  decryptMqttResponse,
  loginWithCode,
  sendSmsCode,
  generateSlideVerify,
  // AI 自动回复
  chatCompletion,
  chat,
  ConversationStore,
  AutoReplyBot,
} from '../types/index.d.ts';

// Pure types (type-only)
export type {
  Conversation,
  MessageContent,
  Message,
  ReceivedMessage,
  ParsedMessageContent,
  CompanyInfo,
  ConnectParams,
  LoginResult,
  AutoLoginOptions,
  SendTextResult,
  SendMessageResult,
  MessageCallback,
  StatusCallback,
  ReconnectCallback,
  KickedOffCallback,
  NotificationCallback,
  Unsubscribe,
  SessionData,
  SessionSummary,
  QXDimLoginOptions,
  QXDimLoginResult,
  QXDimSendTextOptions,
  QXDimClientConnectOptions,
  PcSessionResult,
  RouteResult,
  ProtoMessage,
  ReloginEvent,
  ReloginCallback,
  TokenHealthCheckOptions,
  TokenHealthCheckResult,
  UploadResult,
  UploadMediaOptions,
  SendMediaResult,
  // AI 自动回复类型
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  ConversationStoreOptions,
  ConversationEntry,
  AutoReplyBotOptions,
  AutoReplyStats,
} from '../types/index.d.ts';
