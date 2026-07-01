/**
 * 企讯达 (QXDIM) SDK - 主类型定义
 *
 * 完整 API 类型，与 src/index.js 的导出一一对应
 *
 * 用法:
 *   // TypeScript 项目
 *   import { QXDim, ConnectionStatus, ReceivedMessage } from 'qxdim';
 *   const qxd: QXDim = new QXDim();
 *   qxd.onMessage((msg: ReceivedMessage) => console.log(msg.text));
 *
 *   // JavaScript 项目（VSCode 自动识别）
 *   // types 字段已配置，.d.ts 自动生效
 */

// ==================== 基础枚举 ====================

/** 连接状态 */
export enum ConnectionStatus {
  UNCONNECTED = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  RECEIVING = 3,
  KICKED_OFF = 7,
}

/** 会话类型 */
export enum ConversationType {
  Single = 0,
  Group = 1,
  Channel = 2,
  ChatRoom = 3,
}

/** 消息内容类型（节选，完整 129 种见 message-parser.js） */
export enum ContentType {
  Unknown = 0,
  Text = 1,
  Voice = 2,
  Image = 3,
  Location = 4,
  File = 5,
  Video = 6,
  Sticker = 7,
  Link = 8,
  P_Text = 9,
  UserCard = 10,
  RecallMessage_Notification = 80,
  Tip_Notification = 90,
  Typing = 91,
}

/** 媒体类型 */
export enum MediaType {
  General = 0,
  Image = 1,
  Voice = 2,
  Video = 3,
  File = 4,
  Portrait = 5,
  Favorite = 6,
  Sticker = 7,
  Moments = 8,
}

/** 持久化标志 */
export enum PersistFlag {
  No_Persist = 0,
  Persist = 1,
  Persist_And_Count = 3,
  Transparent = 4,
}

// ==================== 消息结构 ====================

/** 会话标识 */
export interface Conversation {
  /** 0=单聊, 1=群聊, 2=频道, 3=聊天室 */
  type: ConversationType | number;
  /** 目标 ID（单聊=userId，群聊=groupId） */
  target: string;
  /** 消息线（默认 0） */
  line: number;
}

/** 消息内容（protobuf MessageContent） */
export interface MessageContent {
  /** 内容类型编号 (1=Text, 2=Voice, 3=Image ...) */
  type: ContentType | number;
  /** 可搜索文本（Text 类型用） */
  searchableContent?: string;
  /** 推送文本 */
  pushContent?: string;
  /** JSON 格式内容数据 */
  content?: string;
  /** 二进制内容（base64 字符串） */
  data?: string | Uint8Array;
  /** 媒体类型 */
  mediaType?: MediaType | number;
  /** 远程媒体地址 */
  remoteMediaUrl?: string;
  /** 持久化标志 */
  persistFlag?: PersistFlag | number;
  /** 过期时间（秒） */
  expireDuration?: number;
  /** @类型 (0=无, 1=@all, 2=@specific) */
  mentionedType?: number;
  /** @目标列表 */
  mentionedTarget?: string[];
  /** 扩展数据（JSON） */
  extra?: string;
  /** 推送附加数据 */
  pushData?: string;
}

/** 消息（protobuf Message） */
export interface Message {
  conversation: Conversation;
  /** 发送者 userId */
  fromUser: string;
  content: MessageContent;
  /** 消息 ID（int64，转 string） */
  messageId?: string;
  /** 服务器时间戳（ms, int64 转 string） */
  serverTimestamp?: string;
  /** 接收者（特定场景） */
  toUser?: string;
  /** 接收者列表 */
  to?: string[];
  /** 发送者 ID */
  fromId?: number;
}

/** SDK 包装后的友好消息格式（onMessage 回调参数） */
export interface ReceivedMessage {
  /** 文本内容（Text 类型用，其他类型可能为空） */
  text: string;
  /** 发送者 userId */
  fromUserId: string;
  /** 消息 ID（string 形式，因为 int64） */
  messageId: string;
  /** 服务器时间戳（ms, string 形式） */
  serverTimestamp: string;
  /** 原始会话 */
  conversation: Conversation;
  /** 原始 MessageContent */
  content: MessageContent;
  /** parseMessageContent 解析后的结构 */
  parsed: ParsedMessageContent | null;
  /** 原始 protobuf Message 对象 */
  raw: Message;

  // ★ 媒体消息字段（根据 content.type 设置）
  /** 媒体类型: 'image'|'voice'|'video'|'file'|'location'|'sticker'|undefined */
  mediaType?: 'image' | 'voice' | 'video' | 'file' | 'location' | 'sticker';
  /** 图片 URL (Image 类型) */
  imageUrl?: string;
  /** 语音 URL (Voice 类型) */
  voiceUrl?: string;
  /** 视频 URL (Video 类型) */
  videoUrl?: string;
  /** 文件 URL (File 类型) */
  fileUrl?: string;
  /** 表情 URL (Sticker 类型) */
  stickerUrl?: string;
  /** 缩略图 (Image/Video 类型, base64) */
  thumbnail?: string | Uint8Array;
  /** 图片/视频尺寸 */
  dimensions?: { w?: number; h?: number; width?: number; height?: number };
  /** 语音/视频时长（秒） */
  duration?: number;
  /** 文件名 (File 类型) */
  fileName?: string;
  /** 文件大小 (File 类型) */
  fileSize?: number;
  /** 位置标题 (Location 类型) */
  title?: string;
  /** 纬度 (Location 类型) */
  lat?: number;
  /** 经度 (Location 类型) */
  long?: number;
}

/** parseMessageContent 的返回类型 */
export interface ParsedMessageContent {
  type: number;
  typeName: string;
  raw: MessageContent;
  text?: string;
  imageUrl?: string;
  voiceUrl?: string;
  videoUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileUrl?: string;
  [key: string]: unknown;
}

// ==================== 登录 / 连接参数 ====================

/** 企业信息（/query_company_server 返回） */
export interface CompanyInfo {
  companyCode: string;
  companyName: string;
  unifiedSocialCreditCode: string;
  appServerHost: string;
  imServerHost: string;
  proxyServerHost: string;
  pcProxyHost: string;
  proxyServerAccount: string;
  proxyServerPass: string;
  forceProxy: string;
  webHost: string;
  turnServerHost: string | null;
}

/** autoLogin / QXDim.login 返回的连接参数 */
export interface ConnectParams {
  /** MQTT 服务器主机 */
  host: string;
  /** MQTT WSS 端口 */
  port: number;
  /** 用户 ID */
  userId: string;
  /** 客户端 ID */
  clientId: string;
  /** MQTT 密码 (Buffer) */
  password: Buffer;
  /** 节点标识 */
  node: string;
  /** IM 服务器主机名（serviceHost） */
  serviceHost: string;
  /** AES 加密密钥 (UUID1) */
  tokenKey: string;
  /** AES 解密密钥 (UUID2) */
  privateSecret: string;
  /** 是否用 WSS */
  useWSS: boolean;
  /** 加密后的 token (等同于浏览器 localStorage 的 token) */
  encryptedToken: string;
  /** appServer 地址 */
  appServer?: string;
  /** /route 代理地址 */
  proxyServer?: string;
  /** 企业 ID */
  companyCode?: string | null;
  /** 企业信息 */
  companyInfo?: CompanyInfo | null;
  /** 登录 API 返回结果 */
  loginResult?: LoginResult | null;
}

/** /login_pwd 返回的登录结果 */
export interface LoginResult {
  userId: string;
  token: string;
  userName: string;
  portrait: string;
  register: boolean;
  resetCode?: string | null;
}

/** autoLogin 选项 */
export interface AutoLoginOptions {
  /** 企业 ID（推荐，自动 DNS 解析） */
  companyCode?: string;
  /** 手机号（必须，如 "+86 13800000000"） */
  mobile: string;
  /** 密码（缓存命中时可省略） */
  password?: string;
  /** 已知的 appServer（跳过企业 ID 解析） */
  appServer?: string;
  /** 已知的 serviceHost */
  serviceHost?: string;
  /** 已知的 proxyServer（默认同 appServer） */
  proxyServer?: string;
  /** 直连参数（/route 不可用时） */
  directConnect?: {
    mqttHost: string;
    mqttPort: number;
    node?: string;
  };
  /** 客户端 ID（不传自动生成） */
  clientId?: string;
  /** 平台编号（默认 5=Web） */
  platform?: number;
  /** 是否优先 /route */
  preferRoute?: boolean;
  /** 是否使用本地 session 缓存（默认 true） */
  useCache?: boolean;
  /** 强制重新登录（默认 false） */
  relogin?: boolean;
  /** 登录后是否写缓存（默认 true） */
  saveCache?: boolean;
  /** 是否调 /pc_session（默认 true） */
  usePcSession?: boolean;
}

// ==================== 发送消息结果 ====================

/** sendText 返回 */
export interface SendTextResult {
  /** 全局唯一消息 ID (bigint) */
  messageUid: bigint;
  /** 服务器时间戳 (bigint, ms) */
  timestamp: bigint;
  /** 时间戳对应的 Date 对象 */
  timestampDate: Date;
  /** 原始 8 字节 messageUid (大端序) */
  messageUidBuffer: Buffer;
  /** 原始 8 字节 timestamp (大端序) */
  timestampBuffer: Buffer;
}

/** sendMessage 返回（底层） */
export interface SendMessageResult {
  messageUid: Buffer;
  timestamp: Buffer;
  messageUidLong: bigint;
  timestampLong: bigint;
  raw: Buffer;
}

/** ★ sendImage/sendVideo/sendMedia 返回 */
export interface SendMediaResult {
  /** 全局唯一消息 ID (bigint) */
  messageUid: bigint;
  /** 服务器时间戳 (bigint, ms) */
  timestamp: bigint;
  /** 时间戳对应的 Date 对象 */
  timestampDate: Date;
  /** OSS 媒体 URL */
  mediaUrl: string;
  /** 媒体类型（sendMedia 时有） */
  mediaType?: OSSMediaType;
}

// ==================== 回调类型 ====================

export type MessageCallback = (msg: ReceivedMessage) => void;
export type StatusCallback = (status: ConnectionStatus) => void;
export type ReconnectCallback = (attempt: number) => void;
export type KickedOffCallback = (reason: string, info: unknown) => void;
export type NotificationCallback = (notification: { type: string; data: unknown }) => void;

/** ★ 重登事件（token 失效自动重登时触发） */
export interface ReloginEvent {
  /** 'start'=开始重登, 'success'=重登成功, 'error'=重登失败 */
  phase: 'start' | 'success' | 'error';
  /** 第几次尝试 (1-based) */
  attempt: number;
  /** 失败原因（start/error 时有） */
  reason?: string;
  /** 错误消息（error 时有） */
  error?: string;
  /** 原始 info（start 时有） */
  info?: unknown;
}

export type ReloginCallback = (event: ReloginEvent) => void;

/** 取消注册函数 */
export type Unsubscribe = () => void;

// ==================== Session 持久化 ====================

/** 保存的 session 数据 */
export interface SessionData {
  mobile: string;
  userId: string;
  userName: string;
  clientId: string;
  encryptedToken: string;
  tokenPart1: string;
  tokenKey: string;
  privateSecret: string;
  host: string;
  port: number;
  node: string;
  serviceHost: string;
  appServer?: string;
  proxyServer?: string;
  companyCode?: string | null;
  companyInfo?: CompanyInfo | null;
  loginResult?: {
    userId: string;
    userName: string;
    portrait: string;
    register: boolean;
  } | null;
  loginAt: number;
  lastUsedAt: number;
}

/** listSessions 返回的摘要 */
export interface SessionSummary {
  mobile: string;
  userId: string;
  userName: string;
  clientId: string;
  companyCode: string | null;
  companyName: string | null;
  appServer: string | null;
  loginAt: number;
  lastUsedAt: number;
}

// ==================== 高级 SDK: QXDim ====================

export interface QXDimLoginOptions {
  /** 使用本地 session 缓存（默认 true） */
  useCache?: boolean;
  /** 强制重新登录（默认 false） */
  relogin?: boolean;
  /** 启用自动重连（默认 true） */
  autoReconnect?: boolean;
  /** 重连间隔毫秒（默认 5000） */
  reconnectPeriod?: number;
  /** ★ token 失效时自动重新登录（默认 true） */
  autoRelogin?: boolean;
  /** ★ 最大重登次数（默认 3） */
  maxReloginAttempts?: number;
}

export interface QXDimLoginResult {
  userId: string;
  userName: string;
  companyName: string;
}

export interface QXDimSendTextOptions {
  /** 会话类型（默认 0=单聊） */
  conversationType?: ConversationType | number;
  /** 消息线（默认 0） */
  line?: number;
}

/** ★ 高级 SDK 类 */
export class QXDim {
  constructor();

  /** 登录（自动跑完整 7 步流程 + MQTT 连接 + 订阅） */
  login(
    companyCode: string,
    mobile: string,
    password: string,
    options?: QXDimLoginOptions
  ): Promise<QXDimLoginResult>;

  /** 发送文本消息 */
  sendText(
    targetUserId: string,
    text: string,
    options?: QXDimSendTextOptions
  ): Promise<SendTextResult>;

  /** ★ 发送图片消息（自动上传到 OSS） */
  sendImage(
    targetUserId: string,
    image: { data: Buffer | Uint8Array; fileName: string; width?: number; height?: number },
    options?: QXDimSendTextOptions
  ): Promise<SendMediaResult>;

  /** ★ 发送视频消息（自动上传到 OSS） */
  sendVideo(
    targetUserId: string,
    video: { data: Buffer | Uint8Array; fileName: string; duration?: number; thumbnail?: Buffer },
    options?: QXDimSendTextOptions
  ): Promise<SendMediaResult>;

  /** ★ 发送任意媒体消息（文件/语音等，自动上传到 OSS） */
  sendMedia(
    targetUserId: string,
    media: {
      data: Buffer | Uint8Array;
      fileName: string;
      mediaType?: OSSMediaType;
      duration?: number;
    },
    options?: QXDimSendTextOptions
  ): Promise<SendMediaResult>;

  /** 注册消息回调，返回取消函数 */
  onMessage(callback: MessageCallback): Unsubscribe;

  /** 注册状态变更回调 */
  onStatusChange(callback: StatusCallback): Unsubscribe;

  /** 注册重连回调 */
  onReconnect(callback: ReconnectCallback): Unsubscribe;

  /** 注册被踢下线回调 */
  onKickedOff(callback: KickedOffCallback): Unsubscribe;

  /** ★ 注册重登回调（token 失效自动重登时触发） */
  onRelogin(callback: ReloginCallback): Unsubscribe;

  /** 主动拉取历史消息 */
  pullMessages(fromHead?: number | string, type?: number): Promise<unknown>;

  /** 断开连接 */
  disconnect(): Promise<void>;

  /** 获取当前连接状态 */
  getStatus(): ConnectionStatus;

  /** 获取当前用户信息 */
  getUserInfo(): {
    userId: string;
    userName: string;
    clientId: string;
    companyName: string;
    companyCode: string | null;
  } | null;
}

// ==================== 底层 MQTT 客户端 ====================

export interface QXDimClientConnectOptions {
  host: string;
  port: number;
  userId: string;
  clientId: string;
  password: Buffer;
  node: string;
  serviceHost: string;
  tokenKey: string;
  privateSecret: string;
  useWSS?: boolean;
  /** 是否启用自动重连（默认 true） */
  autoReconnect?: boolean;
  /** 重连间隔毫秒（默认 5000） */
  reconnectPeriod?: number;
}

export class QXDimClient {
  constructor();

  connect(options: QXDimClientConnectOptions): void;

  onMessage(callback: (message: Message) => void): void;
  onNotification(callback: NotificationCallback): void;
  onStatusChange(callback: StatusCallback): void;
  onReconnect(callback: ReconnectCallback): void;
  onKickedOff(callback: KickedOffCallback): void;
  /** ★ 认证失败回调（重连超过 maxReconnectAttempts 或 CONNACK 拒绝时触发） */
  onAuthFailed(callback: (reason: string, info: unknown) => void): void;

  sendMessage(
    conversation: Conversation,
    content: MessageContent
  ): Promise<SendMessageResult | null>;

  pullMessages(
    head: number | string,
    type: number
  ): Promise<unknown>;

  disconnect(): void;

  /** 手动重连（用于 token 刷新后） */
  reconnectWithNewCredentials(newParams?: Partial<QXDimClientConnectOptions>): Promise<void>;

  /** 当前连接状态 */
  status: ConnectionStatus;
  /** 当前用户 ID */
  userId: string;
  /** 当前客户端 ID */
  clientId: string;
  /** 上次已读消息版本号 */
  lastMsgHead: number | string;
  /** 重连尝试次数 */
  reconnectAttempt: number;
  /** ★ 最大重连次数（超过后触发 authFailed） */
  maxReconnectAttempts: number;
}

// ==================== 完整登录流程各阶段 ====================

/** DNS TXT 解析 */
export function resolveCompanyAppServers(
  companyCode: string,
  dohServer?: string
): Promise<string[]>;

/** /query_company_server */
export function queryCompanyServer(
  companyCode: string,
  candidateServers: string[]
): Promise<CompanyInfo>;

/** /pc_session 返回 */
export interface PcSessionResult {
  token: string;
  expired: number;
  status: number;
  cookie: string | null;
}

/** /pc_session */
export function getPcSession(options: {
  appServerHost: string;
  clientId: string;
  platform?: number;
  deviceName?: string;
}): Promise<PcSessionResult>;

/** /session_login/<token> */
export function sessionLogin(options: {
  appServerHost: string;
  pcSessionToken: string;
  cookie?: string | null;
}): Promise<boolean>;

/** ★ Token 健康检查选项 */
export interface TokenHealthCheckOptions {
  /** 最大尝试次数 (默认 5) */
  maxAttempts?: number;
  /** 每次间隔毫秒 (默认 1000) */
  intervalMs?: number;
  /** 总超时毫秒 (默认 15000) */
  timeoutMs?: number;
  /** 日志前缀 */
  logPrefix?: string;
}

/** ★ Token 健康检查结果 */
export interface TokenHealthCheckResult {
  /** 是否就绪 */
  ready: boolean;
  /** 尝试次数 */
  attempts: number;
  /** 总耗时毫秒 */
  durationMs: number;
  /** 最后一次错误（ready=false 时有） */
  lastError?: string;
  /** /route 返回的连接参数（ready=true 时有） */
  routeResult?: RouteResult;
}

/** ★ 用 /route 探针轮询检测 token 是否生效 */
export function checkTokenReady(
  options: {
    userId: string;
    token: string;
    clientId: string;
    proxyServer: string;
    serviceHost: string;
  },
  checkOptions?: TokenHealthCheckOptions
): Promise<TokenHealthCheckResult>;

// ==================== 媒体上传 ====================

/** OSS 媒体类型编号 */
export enum OSSMediaType {
  General = 0,
  Image = 1,
  Voice = 2,
  Video = 3,
  File = 4,
  Portrait = 5,
}

/** 上传结果 */
export interface UploadResult {
  /** 公开访问 URL */
  url: string;
  /** OSS object key */
  objectKey: string;
  /** 文件大小 */
  size: number;
  /** 媒体类型 */
  mediaType?: OSSMediaType;
}

/** 上传选项 */
export interface UploadMediaOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  userId: string;
  mediaType: OSSMediaType;
  fileName: string;
  data: Buffer | Uint8Array;
  region?: string;
}

/** 上传文件到 OSS */
export function uploadMedia(options: UploadMediaOptions): Promise<UploadResult>;

/** 从 connectParams 自动提取参数上传 */
export function uploadFromConnectParams(
  connectParams: ConnectParams,
  data: Buffer | Uint8Array,
  fileName: string,
  mediaType?: OSSMediaType
): Promise<UploadResult>;

/** 从 portrait URL 提取 OSS endpoint */
export function extractOssEndpoint(portraitUrl: string): string | null;

/** 从 portrait URL 提取 OSS bucket */
export function extractOssBucket(portraitUrl: string, companyCode?: string): string | null;

/** 根据文件扩展名推断 mediaType */
export function inferMediaType(fileName: string): OSSMediaType;

/** 生成 OSS object key */
export function generateObjectKey(
  userId: string,
  mediaType: OSSMediaType,
  fileName: string
): string;

/** /login_pwd */
export function loginWithPassword(options: {
  mobile: string;
  password: string;
  appServer: string;
  clientId?: string;
  platform?: number;
  slideVerifyToken?: string;
  pcSessionToken?: string;
}): Promise<LoginResult>;

/** /route 返回 */
export interface RouteResult {
  host: string;
  longPort: number;
  shortPort: number;
  wssPort: number;
  node: string;
  commercial: number;
  candidate: Array<{ host: string; longPort: number; shortPort: number; wssPort: number }>;
  tokenKey: string;
  tokenPart1: string;
  uuid2: string;
  mqttPassword: Buffer;
  privateSecret: string;
}

/** /route */
export function requestRoute(options: {
  userId: string;
  token: string;
  clientId: string;
  proxyServer: string;
  serviceHost: string;
}): Promise<RouteResult>;

/** autoLogin（完整 7 步流程） */
export function autoLogin(options: AutoLoginOptions): Promise<ConnectParams>;

// ==================== Session 持久化 API ====================

export function normalizeMobile(mobile: string): string;
export function getSessionPath(mobile: string): string;
export function loadSession(mobile: string): Promise<SessionData | null>;
export function saveSession(mobile: string, data: Partial<SessionData>): Promise<SessionData>;
export function clearSession(mobile: string): Promise<boolean>;
export function listSessions(): Promise<SessionSummary[]>;
export function isSessionValid(session: SessionData | null): boolean;

// ==================== 环境变量加载 ====================

/** loadEnv 返回值 */
export interface LoadEnvResult {
  loaded: boolean;
  path: string | null;
  count: number;
}

/** 加载 .env 文件到 process.env */
export function loadEnv(envPath?: string, options?: { override?: boolean }): LoadEnvResult;

// ==================== 加密 / Proto / 工具 ====================

export function aesEncrypt(
  data: string | Buffer | Uint8Array,
  keyStr?: string,
  includeTimestamp?: boolean
): string;

export function aesDecrypt(
  base64Data: string,
  keyStr?: string,
  checkTimestamp?: boolean
): Buffer | null;

export function generateWillTopic(node: string, serviceHost: string): string;
export function xorObfuscate(str: string, key?: number): string;
export function getDefaultKey(): number[];
export function enableSM4(): void;
export function disableSM4(): void;

export const utils: {
  deriveKey: (str: string) => Uint8Array;
  bytesToString: (bytes: ArrayLike<number>) => string;
  stringToBytes: (str: string) => number[];
  bytesToHex: (bytes: ArrayLike<number>) => string;
  hexToBytes: (hex: string) => number[];
  bytesToBase64: (bytes: ArrayLike<number>) => string;
  base64ToBytes: (base64: string) => Buffer;
};

export interface ProtoMessage {
  [key: string]: unknown;
  toJSON(): Record<string, unknown>;
}

export function initProto(): Promise<unknown>;
export function getType(typeName: string): unknown;
export function encode(typeName: string, payload: Record<string, unknown>): Uint8Array;
export function decode(typeName: string, buffer: Uint8Array | Buffer): ProtoMessage;
export function toJSON(message: ProtoMessage): Record<string, unknown>;

// ==================== 消息解析工具 ====================

export function parseMessageContent(content: MessageContent): ParsedMessageContent;
export function formatMessageContent(parsed: ParsedMessageContent): string;
export function getContentTypeName(type: number): string;

// ==================== 其他 ====================

export function decryptTokenLocally(encryptedToken: string): {
  tokenPart1: string;
  tokenKey: string;
  privateSecret: string;
  mqttPassword: Buffer;
};

export function buildDirectConnectConfig(options: {
  token: string;
  mqttHost: string;
  mqttPort: number;
  userId?: string;
  clientId?: string;
  serviceHost?: string;
  node?: string;
  privateSecret?: string;
  mqttPassword?: Buffer;
}): ConnectParams;

export function encryptRawToken(rawToken: string): string;
export function parseRawToken(rawToken: string): {
  tokenPart1: string;
  tokenKey: string;
  uuid2: string;
  privateSecret: string;
  mqttPassword: Buffer;
};
export function parseEncryptedToken(encryptedToken: string): {
  tokenPart1: string;
  tokenKey: string;
  privateSecret: string;
  mqttPassword: Buffer;
};

export function ensureMqttPatched(): void;
export function decryptMqttResponse(
  payload: Buffer,
  privateSecret: string
): { status: number; data: Buffer | null; compressed: boolean };

export function loginWithCode(options: {
  mobile: string;
  code: string;
  appServer: string;
  clientId?: string;
  platform?: number;
  slideVerifyToken?: string;
}): Promise<LoginResult>;

export function sendSmsCode(options: {
  mobile: string;
  appServer: string;
  slideVerifyToken?: string;
}): Promise<boolean>;

export function generateSlideVerify(appServer: string): Promise<{
  token: string;
  backgroundImage: string;
  sliderImage: string;
}>;

// ==================== AI 自动回复 ====================

/** DeepSeek API 聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** chatCompletion 请求选项 */
export interface ChatCompletionOptions {
  apiKey: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
  timeout?: number;
  [key: string]: unknown;
}

/** chatCompletion 响应 */
export interface ChatCompletionResult {
  content: string;
  model: string;
  finishReason: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** ConversationStore 构造选项 */
export interface ConversationStoreOptions {
  maxHistoryPerUser?: number;
  persist?: boolean;
  storageDir?: string;
  maxUsers?: number;
}

/** 对话历史记录条目 */
export interface ConversationEntry {
  role: string;
  content: string;
  timestamp: number;
}

/** AutoReplyBot 构造选项 */
export interface AutoReplyBotOptions {
  apiKey: string;
  myUserId: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  errorReply?: string;
  persistHistory?: boolean;
  rateLimitMs?: number;
  maxHistoryPerUser?: number;
  maxTrackedUsers?: number;
}

/** AutoReplyBot 统计信息 */
export interface AutoReplyStats {
  received: number;
  processed: number;
  replied: number;
  errors: number;
  skipped: number;
  activeUsers: number;
  processingCount: number;
}

/** DeepSeek API 客户端 */
export declare function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult>;
export declare function chat(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  options?: Record<string, unknown>
): Promise<string>;

/** 对话历史管理 */
export declare class ConversationStore {
  constructor(options?: ConversationStoreOptions);
  getHistory(userId: string): Promise<ConversationEntry[]>;
  addMessage(userId: string, role: string, content: string): Promise<void>;
  clear(userId: string): Promise<void>;
  clearAll(): Promise<void>;
  listUsers(): Promise<string[]>;
}

/** AI 自动回复机器人 */
export declare class AutoReplyBot {
  constructor(options: AutoReplyBotOptions);
  handleMessage(msg: ReceivedMessage, qxd: QXDim): Promise<void>;
  clearUserHistory(userId: string): Promise<void>;
  clearAllHistory(): Promise<void>;
  getStats(): Promise<AutoReplyStats>;
}
