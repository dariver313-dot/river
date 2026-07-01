/**
 * QXDim — 企讯达 IM 高级 SDK
 *
 * 把 autoLogin + QXDimClient + parseMessageContent 封装成更简洁的 API：
 *
 *   const qxd = new QXDim();
 *   await qxd.login('your_company_code', '+86 13800000000', 'your_password');
 *   qxd.onMessage((msg) => logger.debug('收到:', msg.text, 'from:', msg.fromUserId));
 *   qxd.onStatusChange((s) => logger.debug('状态:', s));
 *   qxd.onReconnect((n) => logger.debug('重连第', n, '次'));
 *   qxd.onKickedOff((reason) => logger.debug('被踢:', reason));
 *   await qxd.sendText('88dv45ixr', 'Hello!');
 *   await qxd.disconnect();
 *
 * 消息格式 (onMessage 回调):
 *   {
 *     text: string,            // 文本内容 (Text 类型)
 *     fromUserId: string,      // 发送者 userId
 *     messageId: string,       // 消息 ID (string, 因为是 int64)
 *     serverTimestamp: string, // 服务器时间戳 (ms, string)
 *     conversation: { type, target, line },
 *     content: { type, searchableContent, ... },  // 原始 protobuf
 *     parsed: object,          // parseMessageContent 解析后的结构
 *   }
 */

import { initProto } from './proto/index.js';
import { autoLogin } from './protocol/auto-login.js';
import { QXDimClient, ConnectionStatus } from './protocol/mqtt-client.js';
import {
  parseMessageContent,
  formatMessageContent,
  ContentType,
  PersistFlag,
} from './utils/message-parser.js';
import { uploadFromConnectParams, MediaType, inferMediaType } from './protocol/media-upload.js';
import { assertNonEmpty, assertString, assertBufferLike, assertRequiredFields, assertInt } from './utils/validate.js';
import { clearSession } from './protocol/session-store.js';
import { checkTokenReady } from './protocol/token-health.js';
import { logger } from './utils/logger.js';

export class QXDim {
  constructor() {
    this.client = null;
    this.connectParams = null;
    this.loggedIn = false;
    // 登录凭据（用于自动重登）
    this._companyCode = null;
    this._mobile = null;
    this._password = null;
    this._loginOptions = null;
    // 自动重登状态
    this._autoReloginEnabled = true;
    this._reloginInProgress = false;
    this._reloginAttempts = 0;
    this._maxReloginAttempts = 3;
    this._reloginCallbacks = [];
    // 用户回调
    this._messageCallbacks = [];
    this._statusCallbacks = [];
    this._reconnectCallbacks = [];
    this._kickedOffCallbacks = [];
  }

  /**
   * 登录
   *
   * @param {string} companyCode - 企业 ID (如 "your_company_code")
   * @param {string} mobile - 手机号 (如 "+86 13800000000")
   * @param {string} password - 密码
   * @param {object} [options]
   * @param {boolean} [options.useCache=true] - 使用本地 session 缓存
   * @param {boolean} [options.relogin=false] - 强制重新登录
   * @param {boolean} [options.autoReconnect=true] - 启用自动重连
   * @param {number} [options.reconnectPeriod=5000] - 重连间隔
   * @param {boolean} [options.autoRelogin=true] - ★ token 失效时自动重新登录
   * @param {number} [options.maxReloginAttempts=3] - ★ 最大重登次数
   * @returns {Promise<{userId, userName, companyName}>}
   */
  async login(companyCode, mobile, password, options = {}) {
    const {
      useCache = true,
      relogin = false,
      autoReconnect = true,
      reconnectPeriod = 5000,
      autoRelogin = true,            // ★ token 失效时自动重登
      maxReloginAttempts = 3,        // ★ 最大重登次数
    } = options;

    // ★ 保存凭据供自动重登使用
    this._companyCode = companyCode;
    this._mobile = mobile;
    this._password = password;
    this._loginOptions = { useCache, relogin, autoReconnect, reconnectPeriod, autoRelogin, maxReloginAttempts };
    this._autoReloginEnabled = autoRelogin;
    this._maxReloginAttempts = maxReloginAttempts;
    this._reloginAttempts = 0;

    // 初始化 protobuf
    await initProto();

    // 登录 + 路由
    this.connectParams = await autoLogin({
      companyCode,
      mobile,
      password,
      useCache,
      relogin,
      saveCache: true,
      usePcSession: true,
    });

    // 建立 MQTT 连接
    this._setupClient();

    // 等连接建立
    await this._waitForConnection();
    this.loggedIn = true;
    // 登录成功后重置重登计数
    this._reloginAttempts = 0;

    return {
      userId: this.connectParams.userId,
      userName: this.connectParams.loginResult?.userName || '',
      companyName: this.connectParams.companyInfo?.companyName || '',
    };
  }

  /**
   * ★ 内部方法: 创建 QXDimClient 并注册所有回调
   * 首次连接和重登后重连都用这个
   */
  _setupClient() {
    this.client = new QXDimClient();

    // 注册内部回调 → 分发给用户的 callbacks
    this.client.onMessage((message) => this._dispatchMessage(message));
    this.client.onStatusChange((s) => this._dispatchStatus(s));
    this.client.onReconnect((attempt) => this._dispatchReconnect(attempt));
    this.client.onKickedOff((reason, info) => this._dispatchKickedOff(reason, info));

    // ★ 注册 authFailed 回调 → 触发自动重登
    //   _handleAuthFailed 是 async 方法，这里 fire-and-forget 调用必须加 .catch()
    //   防止未捕获的 rejection 导致 unhandledRejection 事件
    this.client.onAuthFailed((reason, info) => {
      Promise.resolve()
        .then(() => this._handleAuthFailed(reason, info))
        .catch((e) => {
          logger.error('[QXDim] _handleAuthFailed 异常:', e.message);
          // 兜底: 确保重登状态被重置，避免后续重登永久卡住
          this._reloginInProgress = false;
        });
    });

    this.client.connect({
      host: this.connectParams.host,
      port: this.connectParams.port || 443,
      userId: this.connectParams.userId,
      clientId: this.connectParams.clientId,
      password: this.connectParams.password,
      node: this.connectParams.node,
      serviceHost: this.connectParams.serviceHost,
      tokenKey: this.connectParams.tokenKey,
      privateSecret: this.connectParams.privateSecret,
      useWSS: true,
      autoReconnect: this._loginOptions.autoReconnect,
      reconnectPeriod: this._loginOptions.reconnectPeriod,
    });
  }

  /**
   * ★ 处理 authFailed 事件 → 自动重登
   * 流程:
   *   1. clearSession 清除旧缓存
   *   2. autoLogin 重新登录（relogin=true 强制走完整流程）
   *   3. reconnectWithNewCredentials 用新凭据重连
   *   4. 失败则 backoff 后重试，超过 maxReloginAttempts 放弃
   *
   * ★ 用循环替代递归，避免多次重试时栈溢出
   */
  async _handleAuthFailed(reason, info) {
    logger.debug(`\n[QXDim] ⚠️ 认证失败: ${reason}`);
    logger.debug(`[QXDim] info:`, info);

    if (!this._autoReloginEnabled) {
      logger.debug('[QXDim] 自动重登已禁用，交给上层处理');
      this.loggedIn = false;
      this._dispatchKickedOff(reason, info);
      return;
    }

    if (this._reloginInProgress) {
      logger.debug('[QXDim] 已有重登任务在执行，跳过');
      return;
    }

    // ★ 防护: disconnect() 可能已清理凭据，_handleAuthFailed 作为 fire-and-forget 回调
    //   可能在此期间执行。若 connectParams 已被清空，直接放弃重登。
    if (!this.connectParams || !this._companyCode || !this._mobile) {
      logger.error('[QXDim] 凭据已被清理，无法执行自动重登');
      this._dispatchKickedOff(reason, info);
      return;
    }

    // ★ 快照凭据: 防止 disconnect() 在重登循环期间并发清零 this._companyCode 等字段
    const creds = {
      companyCode: this._companyCode,
      mobile: this._mobile,
      password: this._password,
    };

    this._reloginInProgress = true;
    let currentReason = reason;
    let currentInfo = info;

    try {
      // ★ 循环重试，替代递归（避免栈溢出）
      while (this._reloginAttempts < this._maxReloginAttempts && this._autoReloginEnabled) {
        this._reloginAttempts++;
        const attempt = this._reloginAttempts;
        logger.debug(`[QXDim] 🔄 开始自动重登 (第 ${attempt}/${this._maxReloginAttempts} 次)`);

        // 通知用户
        for (const cb of Array.from(this._reloginCallbacks)) {
          try { cb({ phase: 'start', attempt, reason: currentReason, info: currentInfo }); } catch (e) { logger.error('[QXDim] onRelogin 回调异常:', e.message); }
        }

        try {
          // Step 1: 清除旧 session（强制重新登录）
          await clearSession(creds.mobile);
          logger.debug(`[QXDim]   ✓ 已清除旧 session (mobile=${creds.mobile})`);

          // Step 2: 指数退避（1s → 5s → 10s → 20s...），首次重登不浪费时间
          const backoffMs = attempt > 1 ? Math.min(5000 * Math.pow(2, attempt - 2), 30000) : 1000;
          logger.debug(`[QXDim]   ⏳ 等待 ${backoffMs}ms 后重登...`);
          await new Promise(r => setTimeout(r, backoffMs));

          // Step 3: 重新登录（强制重登）
          logger.debug(`[QXDim]   🔄 autoLogin (relogin=true)...`);
          this.connectParams = await autoLogin({
            companyCode: creds.companyCode,
            mobile: creds.mobile,
            password: creds.password,
            useCache: false,         // 不用缓存
            relogin: true,           // 强制重登
            saveCache: true,         // 登录后保存新 session
            usePcSession: true,
          });
          logger.debug(`[QXDim]   ✓ 新 token: tokenKey=<redacted>`);

          // Step 4: 用 /route 探针轮询，等新 token 在 app-server 生效
          logger.debug(`[QXDim]   🔄 重建 MQTT 连接...`);
          logger.debug(`[QXDim]   新凭据: userId=${this.connectParams.userId} clientId=${this.connectParams.clientId} password.len=${this.connectParams.password?.length} tokenKey=<redacted>`);

          // ★ 用 /route 探针轮询，替代固定 2s 延迟
          //   app-server 拿到新 token 后，im-server 同步有延迟
          //   /route 成功 ≠ im-server 已同步，但 /route 失败一定不能试 MQTT
          const probeResult = await checkTokenReady({
            userId: this.connectParams.userId,
            token: this.connectParams.encryptedToken,
            clientId: this.connectParams.clientId,
            proxyServer: this.connectParams.proxyServer || this.connectParams.appServer,
            serviceHost: this.connectParams.serviceHost,
          }, {
            maxAttempts: 5,
            intervalMs: 1000,
            timeoutMs: 10000,
            logPrefix: '[QXDim] [TokenHealth]',
          });

          if (!probeResult.ready) {
            throw new Error(`token 探针失败 (${probeResult.attempts} 次): ${probeResult.lastError}`);
          }
          logger.debug(`[QXDim]   ✓ token 已生效 (耗时 ${probeResult.durationMs}ms, ${probeResult.attempts} 次探针)`);

          // ★ 完全销毁旧 client，重新创建（避免 mqtt.js 内部状态残留）
          if (this.client) {
            try {
              this.client.shouldReconnect = false;
              if (this.client.mqttClient) {
                const oldClient = this.client.mqttClient;
                oldClient.removeAllListeners();
                // ★ 加超时保护：损坏的 socket 可能导致 end() 永不回调
                await new Promise((resolve) => {
                  const timer = setTimeout(() => resolve(), 5000);
                  oldClient.end(true, () => { clearTimeout(timer); resolve(); });
                });
              }
            } catch (e) { /* ignore */ }
            this.client = null;
          }
          this._setupClient();

          // 等连接建立
          await this._waitForConnection(15000);
          this.loggedIn = true;
          this._reloginAttempts = 0;  // 重登成功，重置计数
          logger.debug(`[QXDim] ✅ 重登成功!`);

          // 通知用户
          for (const cb of Array.from(this._reloginCallbacks)) {
            try { cb({ phase: 'success', attempt }); } catch (e) { logger.error('[QXDim] onRelogin 回调异常:', e.message); }
          }
          return;  // ★ 成功，退出循环
        } catch (e) {
          logger.error(`[QXDim] ❌ 重登失败 (第 ${attempt} 次): ${e.message}`);
          // 通知用户
          for (const cb of Array.from(this._reloginCallbacks)) {
            try { cb({ phase: 'error', attempt, error: e.message }); } catch (e2) { logger.error('[QXDim] onRelogin 回调异常:', e2.message); }
          }
          // 更新 reason/info，继续循环重试
          currentReason = `重登失败: ${e.message}`;
          currentInfo = { attempt, originalError: e.message };
          // 循环会自动检查 _reloginAttempts < _maxReloginAttempts
        }
      }

      // 循环结束仍未成功
      logger.error(`[QXDim] ❌ 重登超过 ${this._maxReloginAttempts} 次仍失败，放弃`);
      this.loggedIn = false;
      this._dispatchKickedOff(`重登超过 ${this._maxReloginAttempts} 次仍失败: ${currentReason}`, currentInfo);
    } finally {
      this._reloginInProgress = false;
    }
  }

  /**
   * 发送文本消息
   *
   * @param {string} targetUserId - 接收者 userId
   * @param {string} text - 文本内容
   * @param {object} [options]
   * @param {number} [options.conversationType=0] - 0=单聊, 1=群聊
   * @param {number} [options.line=0] - 消息线
   * @returns {Promise<{messageUid: bigint, timestamp: bigint, timestampDate: Date}>}
   */
  async sendText(targetUserId, text, options = {}) {
    this._ensureLoggedIn();
    // 输入校验
    assertNonEmpty(targetUserId, 'targetUserId');
    assertString(targetUserId, 'targetUserId');
    assertNonEmpty(text, 'text');
    assertString(text, 'text');
    assertInt(options.conversationType ?? 0, 'options.conversationType', 0, 255);
    assertInt(options.line ?? 0, 'options.line', 0, 255);

    const { conversationType = 0, line = 0 } = options;

    const conversation = { type: conversationType, target: targetUserId, line };
    const content = {
      type: ContentType.Text,  // 1
      searchableContent: text,
      persistFlag: PersistFlag.Persist_And_Count,  // 3
    };

    const result = await this.client.sendMessage(conversation, content);
    if (!result) {
      throw new Error('sendText 失败: sendMessage 返回 null');
    }

    return {
      messageUid: result.messageUidLong,
      timestamp: result.timestampLong,
      timestampDate: new Date(Number(result.timestampLong)),
    };
  }

  /**
   * ★ 发送图片消息
   *
   * 流程:
   *   1. 上传图片到 OSS，拿到 URL
   *   2. 发送 Image 类型消息，remoteMediaUrl = OSS URL
   *
   * @param {string} targetUserId - 接收者 userId
   * @param {object} image - { data: Buffer|Uint8Array, fileName: string, width?: number, height?: number }
   * @param {object} [options]
   * @param {number} [options.conversationType=0]
   * @param {number} [options.line=0]
   * @returns {Promise<{messageUid: bigint, timestamp: bigint, timestampDate: Date, mediaUrl: string}>}
   */
  async sendImage(targetUserId, image, options = {}) {
    this._ensureLoggedIn();
    // 输入校验
    assertNonEmpty(targetUserId, 'targetUserId');
    assertString(targetUserId, 'targetUserId');
    assertRequiredFields(image, ['data', 'fileName'], 'image');
    assertBufferLike(image.data, 'image.data');
    assertString(image.fileName, 'image.fileName');
    assertInt(options.conversationType ?? 0, 'options.conversationType', 0, 255);
    assertInt(options.line ?? 0, 'options.line', 0, 255);

    const { conversationType = 0, line = 0 } = options;

    // Step 1: 上传到 OSS
    logger.debug(`[QXDim] sendImage: 上传 ${image.fileName} (${image.data.length} bytes)...`);
    const uploadResult = await uploadFromConnectParams(
      this.connectParams, image.data, image.fileName, MediaType.Image
    );

    // Step 2: 构造图片消息
    // Image 消息: content.content = JSON({w:width, h:height}), remoteMediaUrl = OSS URL
    const dimensions = {
      w: image.width || 0,
      h: image.height || 0,
    };
    const content = {
      type: ContentType.Image,  // 3
      content: JSON.stringify(dimensions),
      remoteMediaUrl: uploadResult.url,
      mediaType: MediaType.Image,
      persistFlag: PersistFlag.Persist_And_Count,
    };

    const conversation = { type: conversationType, target: targetUserId, line };
    const result = await this.client.sendMessage(conversation, content);
    if (!result) {
      throw new Error('sendImage 失败: sendMessage 返回 null');
    }

    return {
      messageUid: result.messageUidLong,
      timestamp: result.timestampLong,
      timestampDate: new Date(Number(result.timestampLong)),
      mediaUrl: uploadResult.url,
    };
  }

  /**
   * ★ 发送视频消息
   *
   * @param {string} targetUserId
   * @param {object} video - { data: Buffer|Uint8Array, fileName: string, duration?: number, thumbnail?: Buffer }
   * @param {object} [options]
   * @returns {Promise<{messageUid: bigint, timestamp: bigint, timestampDate: Date, mediaUrl: string}>}
   */
  async sendVideo(targetUserId, video, options = {}) {
    this._ensureLoggedIn();
    // 输入校验
    assertNonEmpty(targetUserId, 'targetUserId');
    assertString(targetUserId, 'targetUserId');
    assertRequiredFields(video, ['data', 'fileName'], 'video');
    assertBufferLike(video.data, 'video.data');
    assertString(video.fileName, 'video.fileName');
    assertInt(options.conversationType ?? 0, 'options.conversationType', 0, 255);
    assertInt(options.line ?? 0, 'options.line', 0, 255);

    const { conversationType = 0, line = 0 } = options;

    // Step 1: 上传视频到 OSS
    logger.debug(`[QXDim] sendVideo: 上传 ${video.fileName} (${video.data.length} bytes)...`);
    const uploadResult = await uploadFromConnectParams(
      this.connectParams, video.data, video.fileName, MediaType.Video
    );

    // Step 2: 构造视频消息
    // Video 消息: content.content = JSON({d:duration}), remoteMediaUrl = OSS URL, data = thumbnail(base64)
    const videoMeta = {
      d: video.duration || 0,  // 秒
    };
    const content = {
      type: ContentType.Video,  // 6
      content: JSON.stringify(videoMeta),
      remoteMediaUrl: uploadResult.url,
      mediaType: MediaType.Video,
      persistFlag: PersistFlag.Persist_And_Count,
    };

    // 缩略图（可选）
    if (video.thumbnail) {
      content.data = video.thumbnail;  // Buffer，protobufjs 会自动转 base64
    }

    const conversation = { type: conversationType, target: targetUserId, line };
    const result = await this.client.sendMessage(conversation, content);
    if (!result) {
      throw new Error('sendVideo 失败: sendMessage 返回 null');
    }

    return {
      messageUid: result.messageUidLong,
      timestamp: result.timestampLong,
      timestampDate: new Date(Number(result.timestampLong)),
      mediaUrl: uploadResult.url,
    };
  }

  /**
   * ★ 识别但不发送：文件/语音消息
   * 当前的 OSS 上传逻辑支持文件/语音，但 message-parser 不下载内容
   * 接收方收到时只能看到 remoteMediaUrl，无法直接预览
   *
   * 如需发送，可用 sendMedia(targetUserId, {data, fileName, mediaType})
   */
  async sendMedia(targetUserId, media, options = {}) {
    this._ensureLoggedIn();
    // 输入校验
    assertNonEmpty(targetUserId, 'targetUserId');
    assertString(targetUserId, 'targetUserId');
    assertRequiredFields(media, ['data', 'fileName'], 'media');
    assertBufferLike(media.data, 'media.data');
    assertString(media.fileName, 'media.fileName');
    assertInt(options.conversationType ?? 0, 'options.conversationType', 0, 255);
    assertInt(options.line ?? 0, 'options.line', 0, 255);

    const { conversationType = 0, line = 0 } = options;
    const mediaType = media.mediaType ?? inferMediaType(media.fileName);

    logger.debug(`[QXDim] sendMedia: 上传 ${media.fileName} (${media.data.length} bytes, mediaType=${mediaType})...`);
    const uploadResult = await uploadFromConnectParams(
      this.connectParams, media.data, media.fileName, mediaType
    );

    // 根据 mediaType 选择 ContentType
    let contentType;
    if (mediaType === MediaType.Image) contentType = ContentType.Image;
    else if (mediaType === MediaType.Video) contentType = ContentType.Video;
    else if (mediaType === MediaType.Voice) contentType = ContentType.Voice;
    else contentType = ContentType.File;

    const content = {
      type: contentType,
      searchableContent: mediaType === MediaType.File ? media.fileName : '',
      content: mediaType === MediaType.Voice ? JSON.stringify({duration: media.duration || 0}) : '',
      remoteMediaUrl: uploadResult.url,
      mediaType,
      persistFlag: PersistFlag.Persist_And_Count,
    };

    const conversation = { type: conversationType, target: targetUserId, line };
    const result = await this.client.sendMessage(conversation, content);
    if (!result) {
      throw new Error('sendMedia 失败: sendMessage 返回 null');
    }

    return {
      messageUid: result.messageUidLong,
      timestamp: result.timestampLong,
      timestampDate: new Date(Number(result.timestampLong)),
      mediaUrl: uploadResult.url,
      mediaType,
    };
  }

  /**
   * 注册消息回调
   * @param {(msg: object) => void} callback
   * @returns {() => void} 取消注册函数
   */
  onMessage(callback) {
    if (typeof callback !== 'function') throw new TypeError('[QXDim] onMessage callback 必须是函数');
    this._messageCallbacks.push(callback);
    return () => {
      this._messageCallbacks = this._messageCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * 注册状态变更回调
   * @param {(status: number) => void} callback
   *   status: 0=未连接, 1=连接中, 2=已连接, 3=接收中, 7=被踢下线
   */
  onStatusChange(callback) {
    if (typeof callback !== 'function') throw new TypeError('[QXDim] onStatusChange callback 必须是函数');
    this._statusCallbacks.push(callback);
    return () => {
      this._statusCallbacks = this._statusCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * 注册重连回调
   * @param {(attempt: number) => void} callback
   */
  onReconnect(callback) {
    this._reconnectCallbacks.push(callback);
    return () => {
      this._reconnectCallbacks = this._reconnectCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * 注册被踢下线回调
   * @param {(reason: string, info: object) => void} callback
   */
  onKickedOff(callback) {
    this._kickedOffCallbacks.push(callback);
    return () => {
      this._kickedOffCallbacks = this._kickedOffCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * ★ 注册重登回调（token 失效自动重登时触发）
   * @param {(event: {phase: 'start'|'success'|'error', attempt: number, reason?: string, error?: string}) => void} callback
   */
  onRelogin(callback) {
    this._reloginCallbacks.push(callback);
    return () => {
      this._reloginCallbacks = this._reloginCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * 主动拉取消息
   * @param {number|string} [fromHead=0] - 拉取起点
   * @param {number} [type=0] - 拉取类型
   */
  async pullMessages(fromHead = 0, type = 0) {
    this._ensureLoggedIn();
    return await this.client.pullMessages(fromHead, type);
  }

  /**
   * 断开连接
   */
  async disconnect() {
    // ★ 禁用自动重登，通知正在运行的 _handleAuthFailed 循环停止
    this._autoReloginEnabled = false;
    if (this.client) {
      // ★ await mqttClient.end(true) 完成，确保连接真正关闭后再清理凭据
      await this.client.disconnect();
      this.client = null;
    }
    this.loggedIn = false;
    // ★ 安全: 清除内存中的敏感凭据，防止 dump/leak
    this._password = null;
    this._companyCode = null;
    this._mobile = null;
    this._loginOptions = null;
    if (this.connectParams) {
      // 清除 connectParams 中的敏感字段
      this.connectParams.password = null;
      this.connectParams.tokenKey = null;
      this.connectParams.privateSecret = null;
      this.connectParams.encryptedToken = null;
      this.connectParams = null;
    }
    // 重置重登状态
    this._reloginInProgress = false;
    this._reloginAttempts = 0;
  }

  /**
   * 获取当前连接状态
   */
  getStatus() {
    return this.client?.status ?? ConnectionStatus.UNCONNECTED;
  }

  /**
   * 获取当前用户信息
   */
  getUserInfo() {
    if (!this.connectParams) return null;
    return {
      userId: this.connectParams.userId,
      userName: this.connectParams.loginResult?.userName || '',
      clientId: this.connectParams.clientId,
      companyName: this.connectParams.companyInfo?.companyName || '',
      companyCode: this.connectParams.companyCode,
    };
  }

  // ============ 内部方法 ============

  _ensureLoggedIn() {
    if (!this.loggedIn || !this.client) {
      throw new Error('QXDim 尚未登录，请先调用 login()');
    }
  }

  _waitForConnection(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      // ★ 事件驱动: 注册一次性状态回调，避免 100ms 轮询
      //   先检查当前状态（可能已连接），再注册回调
      const currentStatus = this.client?.status;
      if (currentStatus === ConnectionStatus.CONNECTED) {
        resolve();
        return;
      }
      if (currentStatus === ConnectionStatus.KICKED_OFF) {
        reject(new Error('MQTT 连接被拒（KICKED_OFF）— 可能是凭据失效或多端互踢'));
        return;
      }

      let settled = false;
      let timer = null;

      // 注册一次性状态回调
      const unsubscribe = this.onStatusChange((status) => {
        if (settled) return;
        if (status === ConnectionStatus.CONNECTED) {
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          resolve();
        } else if (status === ConnectionStatus.KICKED_OFF) {
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          reject(new Error('MQTT 连接被拒（KICKED_OFF）— 可能是凭据失效或多端互踢'));
        }
      });

      // ★ TOCTOU 防护: 注册回调后重新检查状态，防止在检查和注册之间 CONNECTED 已触发
      if (!settled && this.client?.status === ConnectionStatus.CONNECTED) {
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve();
        return;
      }

      // 超时保护
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error(`MQTT 连接超时 (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  _dispatchMessage(message) {
    // 把原始 protobuf message 包装成更友好的格式
    const content = message.content;
    const parsed = content ? parseMessageContent(content) : null;

    const wrapped = {
      // ★ 文本提取优先级: searchableContent > content.content > parsed.text
      //   部分客户端把文本放在 content.content 而非 searchableContent
      text: content?.searchableContent
        || (content?.type === ContentType.Text || content?.type === ContentType.P_Text
            ? (content?.content || '')
            : '')
        || (parsed?.text || ''),
      fromUserId: message.fromUser,
      messageId: String(message.messageId || ''),
      serverTimestamp: String(message.serverTimestamp || ''),
      conversation: message.conversation,
      content,
      parsed,
      raw: message,
    };

    // ★ 媒体消息字段（图片/语音/视频/文件/位置/表情）
    // 文件/语音: 仅识别类型和 URL，不下载内容
    if (parsed) {
      switch (content.type) {
        case ContentType.Image:
          wrapped.mediaType = 'image';
          wrapped.imageUrl = parsed.imageUrl || content.remoteMediaUrl || '';
          wrapped.thumbnail = parsed.thumbnail || '';
          wrapped.dimensions = parsed.dimensions;
          break;
        case ContentType.Voice:
          wrapped.mediaType = 'voice';
          wrapped.voiceUrl = parsed.voiceUrl || content.remoteMediaUrl || '';
          wrapped.duration = parsed.duration;
          break;
        case ContentType.Video:
          wrapped.mediaType = 'video';
          wrapped.videoUrl = parsed.videoUrl || content.remoteMediaUrl || '';
          wrapped.thumbnail = parsed.thumbnail || '';
          wrapped.duration = parsed.duration;
          break;
        case ContentType.File:
          wrapped.mediaType = 'file';
          wrapped.fileUrl = parsed.fileUrl || content.remoteMediaUrl || '';
          wrapped.fileName = parsed.fileName || '';
          wrapped.fileSize = parsed.fileSize || 0;
          break;
        case ContentType.Location:
          wrapped.mediaType = 'location';
          wrapped.title = parsed.title || '';
          wrapped.lat = parsed.lat;
          wrapped.long = parsed.long;
          break;
        case ContentType.Sticker:
          wrapped.mediaType = 'sticker';
          wrapped.stickerUrl = parsed.stickerUrl || content.remoteMediaUrl || '';
          break;
      }
    }

    // ★ 数组快照: 防止回调内部 add/remove callback 导致迭代错乱
    for (const cb of Array.from(this._messageCallbacks)) {
      try {
        cb(wrapped);
      } catch (e) {
        logger.error('[QXDim] onMessage 回调异常:', e.message);
      }
    }
  }

  _dispatchStatus(status) {
    for (const cb of Array.from(this._statusCallbacks)) {
      try { cb(status); } catch (e) { logger.error('[QXDim] onStatusChange 回调异常:', e.message); }
    }
  }

  _dispatchReconnect(attempt) {
    for (const cb of Array.from(this._reconnectCallbacks)) {
      try { cb(attempt); } catch (e) { logger.error('[QXDim] onReconnect 回调异常:', e.message); }
    }
  }

  _dispatchKickedOff(reason, info) {
    this.loggedIn = false;
    for (const cb of Array.from(this._kickedOffCallbacks)) {
      try { cb(reason, info); } catch (e) { logger.error('[QXDim] onKickedOff 回调异常:', e.message); }
    }
  }
}

export default QXDim;
