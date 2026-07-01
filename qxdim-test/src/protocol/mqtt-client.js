/**
 * 企讯达 MQTT 连接与消息监听模块
 * 通过 MQTT over WebSocket 连接 IM 服务器
 * 
 * v2.0: 基于 WildFireChat 定制协议逆向，修复以下关键问题:
 *   1. PUBACK 响应数据提取（monkey-patch mqtt.js Parser）
 *   2. Push 消息是明文 protobuf（不加密），不再错误地 AES 解密
 *   3. 请求/响应模式: publish → PUBACK callback → 解密响应
 *   4. CONNACK payload 提取（ConnectAckPayload）
 */

import mqtt from 'mqtt';
import zlib from 'zlib';
import Long from 'long';  // ★ 静态 import，替代热路径中的 await import('long')
import { aesEncrypt, aesDecrypt, generateWillTopic } from '../crypto/aes.js';
import { ensureMqttPatched, decryptMqttResponse } from './wfc-mqtt-patch.js';
import * as proto from '../proto/index.js';
import { logger } from '../utils/logger.js';

// ==================== MQTT 主题常量 ====================

// 推送主题（服务器→客户端，通过 PUBLISH 推送，明文 protobuf）
const TOPIC_PUSH_MESSAGE = 'MS';          // 新消息推送
const TOPIC_NOTIFY_MESSAGE = 'MN';        // 消息通知
const TOPIC_GROUP_NOTIFY = 'GMN';         // 群组消息通知
const TOPIC_FRIEND_NOTIFY = 'FN';         // 好友变动通知
const TOPIC_FRIEND_REQUEST = 'FRN';       // 好友请求通知
const TOPIC_USER_SETTING = 'UN';          // 用户设置变更
const TOPIC_RECALL_NOTIFY = 'RMN';        // 撤回消息通知
const TOPIC_READ_NOTIFY = 'RCN';          // 已读通知
const TOPIC_READ_DELIVERY = 'RDN';        // 送达通知
const TOPIC_CONFIG_NOTIFY = 'CONFN';      // 配置变更
const TOPIC_ROFL_NOTIFY = 'ROFL';         // ?
const TOPIC_USER_INPUT = 'UIN';           // 输入状态
const TOPIC_POSITION_NOTIFY = 'POSN';     // 位置通知

// 请求主题（客户端→服务器，通过 PUBLISH 发送加密数据，响应在 PUBACK 中）
const TOPIC_SEND_MESSAGE = 'MS';          // 发送消息
const TOPIC_PULL_MESSAGE = 'MP';          // 拉取消息
const TOPIC_PULL_FRIEND = 'FP';           // 拉取好友列表
const TOPIC_PULL_FRIEND_REQ = 'FRP';      // 拉取好友请求
const TOPIC_ADD_FRIEND = 'FAR';           // 添加好友
const TOPIC_PULL_GROUP_CONV = 'GCP';      // 拉取群会话
const TOPIC_PULL_GROUP_MSG = 'GMP';       // 拉取群消息
const TOPIC_GET_GROUP_INFO = 'GPGI';      // 获取群信息
const TOPIC_AUTH_TOKEN = 'ATR';           // 认证Token请求
const TOPIC_RECV_PULL = 'RCP';            // 接收拉取
const TOPIC_READ_DELIVERY_PULL = 'RDP';   // 已读送达拉取
const TOPIC_UPLOAD_USER_INFO = 'UPUI';    // 上传用户信息
const TOPIC_MULTI_SYNC = 'MGS';           // 多端同步

// ==================== 连接状态 ====================

export const ConnectionStatus = {
  UNCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
  // 3 reserved (RECEIVING — may be wired to message reception in future)
  KICKED_OFF: 7,
};

// ==================== QXDIM MQTT 客户端 ====================

export class QXDimClient {
  constructor() {
    this.mqttClient = null;
    this.privateSecret = '';   // ★ privateSecret = tokenKey
    this.userId = '';
    this.clientId = '';
    this.tokenKey = '';
    this.status = ConnectionStatus.UNCONNECTED;
    this.statusCallback = null;
    this.messageCallback = null;
    this.notificationCallback = null;
    this.reconnectCallback = null;  // ★ 重连回调
    this.kickedOffCallback = null;  // ★ 被踢下线回调
    this.authFailedCallback = null; // ★ 认证失败回调（token 失效，需要上层重登）
    this.errorCallback = null;       // ★ 通用错误回调（TLS/DNS/网络等非认证错误）
    this.routeInfo = null;
    this.serverTime = 0;       // 服务器时间（从 ConnectAckPayload 获取）
    this.lastMsgHead = '0';    // ★ 上次已读消息版本号，统一用字符串存储（避免 int64 精度丢失）
    this.connectParams = null; // ★ 保存连接参数，重连时复用
    this.reconnectAttempt = 0; // ★ 重连尝试次数（0=未在重连）
    this.shouldReconnect = false; // ★ 是否应该自动重连（KICKED_OFF/认证失败时设为 false）
    this.maxReconnectAttempts = 5; // ★ 重连最大次数，超过后触发 authFailedCallback 让上层重登
    // ★ 拉取消息串行化链: 防止并发 _pullAndDispatch 导致重复分发 / lastMsgHead 竞态
    this._pullChain = Promise.resolve();
    this._pullCount = 0;  // 链长计数器，每 1000 次拉取回收一次防止无限增长
    // ★ 重连风暴防护: 记录上次重连时间戳，避免快速失败时 reconnectAttempt 瞬间累加到上限
    this._lastReconnectTime = 0;
  }

  /**
   * 设置状态变更回调
   */
  onStatusChange(callback) {
    this.statusCallback = callback;
  }

  /**
   * 设置消息接收回调
   */
  onMessage(callback) {
    this.messageCallback = callback;
  }

  /**
   * 设置通知接收回调
   */
  onNotification(callback) {
    this.notificationCallback = callback;
  }

  /**
   * ★ 设置重连回调（每次重连尝试时触发）
   * callback(attempt, maxAttempts, err)
   */
  onReconnect(callback) {
    this.reconnectCallback = callback;
  }

  /**
   * ★ 设置被踢下线回调（KICKED_OFF 或认证失败，不会自动重连）
   * callback(reason, info)
   */
  onKickedOff(callback) {
    this.kickedOffCallback = callback;
  }

  /**
   * ★ 设置认证失败回调（重连超过 maxReconnectAttempts 仍失败，或 CONNACK 明确拒绝）
   * 上层应在此回调中: clearSession + autoLogin + reconnectWithNewCredentials
   * callback(reason, info)
   */
  onAuthFailed(callback) {
    this.authFailedCallback = callback;
  }

  /**
   * ★ 设置通用错误回调（TLS握手失败、DNS解析失败等非认证错误）
   * callback(err)
   */
  onError(callback) {
    this.errorCallback = callback;
  }

  /**
   * 连接到 MQTT 服务器
   *
   * @param {object} options
   * @param {boolean} [options.autoReconnect=true] - 是否启用自动重连（默认开）
   * @param {number} [options.reconnectPeriod=5000] - 重连间隔毫秒
   * @param {number} [options.keepalive=3] - MQTT 心跳间隔秒（默认 3s，服务器 ~7s 超时）
   */
  connect({ host, port, userId, clientId, password, node, serviceHost, tokenKey, privateSecret, useWSS = true, autoReconnect = true, reconnectPeriod = 5000, keepalive = 3 }) {
    // ★ 清理旧连接: 防止旧 client 的事件处理器污染新连接状态
    if (this.mqttClient) {
      logger.debug('[MQTT] 清理旧连接，建立新连接');
      this.shouldReconnect = false;
      this.mqttClient.removeAllListeners();
      this.mqttClient.end(true);
      this.mqttClient = null;
    }

    this.userId = userId;
    this.clientId = clientId;
    this.tokenKey = tokenKey;
    this.privateSecret = privateSecret || tokenKey;
    if (this.privateSecret) {
      logger.debug('[MQTT] privateSecret 已设置, 长度:', this.privateSecret.length);
    } else {
      logger.warn('[MQTT] privateSecret 和 tokenKey 均为空，部分消息解密将不可用');
    }

    // ★ 保存连接参数，重连时复用
    this.connectParams = { host, port, userId, clientId, password, node, serviceHost, tokenKey, privateSecret, useWSS, keepalive };
    this.autoReconnect = autoReconnect;
    this.reconnectPeriod = reconnectPeriod;
    this.shouldReconnect = autoReconnect;
    // ★ 重置重连计时
    this.reconnectAttempt = 0;
    this._lastReconnectTime = 0;

    this._setupMqttConnection();
  }

  /**
   * ★ 内部方法: 实际建立 MQTT 连接（首次连接和重连都用这个）
   */
  _setupMqttConnection() {
    const { host, port, userId, clientId, password, node, serviceHost, useWSS, keepalive } = this.connectParams;

    // ★ Node.js mqtt.js 不支持 mqtts:// 直连，必须用 wss:// 走 WebSocket
    const protocol = useWSS ? 'wss' : 'ws';
    const url = `${protocol}://${host}:${port}`;

    const reconnectLabel = this.reconnectAttempt > 0 ? ` (重连第 ${this.reconnectAttempt} 次)` : '';
    logger.debug(`[MQTT] 连接到: ${url}${reconnectLabel}`);
    if (this.reconnectAttempt === 0) {
      logger.debug(`[MQTT] 用户: ${userId}, 密码长度: ${password ? password.length : 0} bytes`);
    }
    this._updateStatus(ConnectionStatus.CONNECTING);

    // 生成 will topic
    const willTopic = generateWillTopic(node || '', serviceHost || '');
    if (this.reconnectAttempt === 0) {
      logger.debug('[MQTT] Will Topic:', willTopic.substring(0, 32) + '...');
    }

    const mqttOptions = {
      keepalive: keepalive || 3,  // ★ 3s 心跳（PINGREQ 每 3s 发一次，服务器 ~7.5s 超时，余量 4.5s）
      clientId: clientId,
      protocolId: 'MQTT',
      protocolVersion: 4,  // ★ MQTT v3.1.1 (mqtt.js 不支持 WFC 自定义的 6)
      clean: true,
      // ★ 重连配置: 自动重连 + 重连后自动重订阅
      reconnectPeriod: this.autoReconnect ? this.reconnectPeriod : 0,
      resubscribe: true,   // ★ 重连后自动重新订阅 (mqtt.js 内置支持)
      connectTimeout: 20000,
      username: userId,
      password: password,
      will: {
        topic: willTopic,
        payload: 'Connection Closed abnormally..!',
        qos: 1,
        retain: false,
      },
    };

    // ★★★ WildFireChat 协议补丁已直接修改 mqtt.js 源码 ★★★
    this.mqttClient = mqtt.connect(url, mqttOptions);
    ensureMqttPatched();

    this.mqttClient.on('connect', (connack) => {
      const wasReconnect = this.reconnectAttempt > 0;
      logger.debug(`[MQTT] ✅ 连接成功!${wasReconnect ? ` (重连第 ${this.reconnectAttempt} 次)` : ''}`);
      logger.debug('[MQTT] Connack returnCode:', connack.returnCode, 'reasonCode:', connack.reasonCode);

      // ★ 认证失败: returnCode 不为 0
      //   MQTT 3.1.1 CONNACK returnCode:
      //   0=接受, 1=不可接受协议版本, 2=标识符被拒, 3=服务不可用, 4=用户名密码错误, 5=未授权
      if (connack.returnCode && connack.returnCode !== 0) {
        // ★ 防护: error 事件可能已先触发并处理了 auth 失败，避免重复回调
        if (!this.shouldReconnect) {
          logger.debug('[MQTT] auth 失败已在 error 事件中处理，跳过 connect handler 的重复回调');
          return;
        }
        const reasonMap = {
          1: '不可接受协议版本',
          2: '标识符被拒',
          3: '服务不可用',
          4: '用户名密码错误',
          5: '未授权 (token 可能已过期)',
        };
        const reason = reasonMap[connack.returnCode] || `未知错误码 ${connack.returnCode}`;
        logger.error(`[MQTT] ❌ 认证失败: ${reason}`);
        this.shouldReconnect = false;  // ★ 认证失败不重连
        this.mqttClient.end(true);
        this._updateStatus(ConnectionStatus.KICKED_OFF);
        // ★ 触发 authFailed 让上层自动重登
        if (this.authFailedCallback) {
          this.authFailedCallback(`CONNACK 认证失败: ${reason}`, { returnCode: connack.returnCode });
        } else if (this.kickedOffCallback) {
          // 兼容: 没注册 authFailed 时退化为 kickedOff
          this.kickedOffCallback(`认证失败: ${reason}`, { returnCode: connack.returnCode });
        }
        return;
      }

      // ★★★ 提取 CONNACK payload（ConnectAckPayload protobuf）★★★
      if (connack.payload && connack.payload.length > 0) {
        if (!wasReconnect) {
          logger.debug('[MQTT] CONNACK payload 长度:', connack.payload.length, 'bytes');
        }
        try {
          const ackPayload = proto.decode('qxdim.ConnectAckPayload', connack.payload);
          const ackData = proto.toJSON(ackPayload);
          if (!wasReconnect) {
            logger.debug('[MQTT] ConnectAckPayload:', JSON.stringify(ackData, null, 2));
          }

          // 保存版本号信息
          this.routeInfo = {
            msgHead: ackData.msgHead,
            friendHead: ackData.friendHead,
            friendRqHead: ackData.friendRqHead,
            settingHead: ackData.settingHead,
            recvHead: ackData.recvHead,
            readHead: ackData.readHead,
            groupConvHead: ackData.groupConvHead,
          };
          this.serverTime = Number(ackData.serverTime) || 0;

          // ★★★ lastMsgHead 处理策略:
          //   首次连接: lastMsgHead = ConnectAckPayload.msgHead (服务器最新版本号)
          //   重连: 保留 lastMsgHead (上次已读位置)，这样能拉取断线期间错过的消息
          if (!wasReconnect || !this.lastMsgHead) {
            this.lastMsgHead = ackData.msgHead;
            logger.debug('[MQTT] 初始 lastMsgHead:', this.lastMsgHead);
          } else {
            logger.debug(`[MQTT] 重连后保留 lastMsgHead: ${this.lastMsgHead} (服务器最新: ${ackData.msgHead})`);
            // 如果服务器 head > 本地 lastMsgHead，说明断线期间有新消息，触发拉取
            // ★ 用 _compareHead (BigInt) 比较，避免 Number() 转换 Long 丢失精度
            if (this._compareHead(ackData.msgHead, this.lastMsgHead) > 0) {
              logger.debug(`[MQTT] 检测到断线期间有新消息 (${this.lastMsgHead} → ${ackData.msgHead})，主动拉取`);
              this._pullAndDispatch(this.lastMsgHead, 0, ackData.msgHead);
            }
          }
        } catch (e) {
          logger.warn('[MQTT] 解析 ConnectAckPayload 失败:', e.message);
          logger.debug('[MQTT] CONNACK payload hex:', connack.payload.toString('hex').substring(0, 100));
        }
      } else if (!wasReconnect) {
        logger.debug('[MQTT] CONNACK 无 payload（标准 MQTT 3.1.1 行为）');
      }

      // ★ 重置重连计数
      if (wasReconnect) {
        logger.debug('[MQTT] ✅ 重连成功，重置重连计数');
        this.reconnectAttempt = 0;
      }

      this._updateStatus(ConnectionStatus.CONNECTED);

      // 订阅推送主题（重连后 resubscribe:true 会自动重订阅，但首次需要手动调）
      // 实际上 mqtt.js resubscribe:true 会自动处理，这里保险起见也调一次
      if (!wasReconnect) {
        this._subscribeTopics();
      }
    });

    // ★★★ 重要: message 事件只处理服务器推送（PUBLISH），不处理请求响应（PUBACK）★★★
    // 推送消息是明文 protobuf，不需要 AES 解密！
    this.mqttClient.on('message', (topic, payload, packet) => {
      this._handlePushMessage(topic, payload);
    });

    this.mqttClient.on('error', (err) => {
      // ★ 可恢复错误（Keepalive timeout 等）降级为 warn，避免生产环境 error 噪声
      const msg = (err.message || '').toLowerCase();
      const isRecoverable = msg.includes('keepalive timeout');
      if (isRecoverable) {
        logger.warn('[MQTT] 连接错误 (可恢复):', err.message);
      } else {
        logger.error('[MQTT] 连接错误:', err.message);
      }
      // ★ 识别认证失败错误（mqtt.js 在 CONNACK returnCode=4/5 时抛 error，不触发 connect 事件）
      //   错误消息关键字: "Connection refused: Bad username or password" / "Not authorized"
      const isAuthError = (
        msg.includes('bad username') ||
        msg.includes('not authorized') ||
        msg.includes('connection refused: bad') ||
        msg.includes('connection refused: not')
      );
      if (isAuthError && this.shouldReconnect) {
        logger.error('[MQTT] ❌ 检测到认证失败错误，停止重连，触发 authFailed');
        this.shouldReconnect = false;
        this.mqttClient.end(true);
        this._updateStatus(ConnectionStatus.KICKED_OFF);
        if (this.authFailedCallback) {
          this.authFailedCallback(`MQTT 认证失败: ${err.message}`, { error: err.message });
        } else if (this.kickedOffCallback) {
          this.kickedOffCallback(`认证失败: ${err.message}`, { error: err.message });
        }
      } else if (!isAuthError && this.errorCallback) {
        // ★ 非认证错误（TLS握手失败、DNS解析失败等）通知上层
        this.errorCallback(err);
      }
      // 其他错误（ECONNRESET/ETIMEDOUT 等）由 close 事件处理重连逻辑
    });

    this.mqttClient.on('close', () => {
      // ★ 不覆盖 KICKED_OFF 状态（认证失败时已设置，上层在轮询该状态）
      if (this.status === ConnectionStatus.KICKED_OFF) {
        logger.debug('[MQTT] 连接关闭 (KICKED_OFF 状态保留)');
        return;
      }

      // ★ 判断是否应该重连
      if (this.shouldReconnect) {
        this.reconnectAttempt++;
        logger.debug(`[MQTT] 连接关闭，${this.reconnectPeriod}ms 后自动重连 (第 ${this.reconnectAttempt} 次)...`);

        // ★ 重连次数超过阈值，认为 token 失效，触发 authFailed 让上层重登
        if (this.reconnectAttempt >= this.maxReconnectAttempts) {
          logger.error(`[MQTT] ❌ 重连超过 ${this.maxReconnectAttempts} 次仍失败，触发 authFailed (token 可能已失效)`);
          this.shouldReconnect = false;
          this.mqttClient.end(true);
          this._updateStatus(ConnectionStatus.UNCONNECTED);
          if (this.authFailedCallback) {
            this.authFailedCallback(
              `重连超过 ${this.maxReconnectAttempts} 次仍失败 (token 可能已失效)`,
              { reconnectAttempt: this.reconnectAttempt }
            );
          }
          return;
        }

        if (this.reconnectCallback) {
          this.reconnectCallback(this.reconnectAttempt);
        }
        this._updateStatus(ConnectionStatus.UNCONNECTED);
        // mqtt.js 内置 reconnectPeriod 会自动重连，不需要手动调
        // 同一个 mqttClient 实例上的事件会继续触发，无需重新绑定
      } else {
        logger.debug('[MQTT] 连接关闭 (不重连)');
        this._updateStatus(ConnectionStatus.UNCONNECTED);
      }
    });

    this.mqttClient.on('offline', () => {
      logger.debug('[MQTT] 离线');
      // ★ offline 事件先于 close 触发，但状态更新统一由 close 处理，避免重复回调
    });

    this.mqttClient.on('disconnect', (packet) => {
      // ★ MQTT 5.0 服务器主动断开 (DISCONNECT 报文)
      //   WildFireChat 用这个表示多端踢下线
      logger.debug('[MQTT] 服务器主动断开连接 (可能是被踢下线):', packet);
      this.shouldReconnect = false;  // ★ 服务器主动断开不重连
      this._updateStatus(ConnectionStatus.KICKED_OFF);
      if (this.kickedOffCallback) {
        this.kickedOffCallback('服务器主动断开 (多端踢下线)', packet);
      }
      this.mqttClient.end(true);
    });

    this.mqttClient.on('reconnect', () => {
      // ★ mqtt.js 内置重连事件
      logger.debug(`[MQTT] 正在重连... (第 ${this.reconnectAttempt} 次)`);
    });
  }

  /**
   * 订阅所有推送主题
   */
  _subscribeTopics() {
    // ★ 逐个订阅: WildFireChat MQTT 服务器不支持单个 SUBSCRIBE 报文包含多个主题过滤器
    //   批量订阅 (对象格式) 会导致服务器断开连接
    //   改为逐个 subscribe，每个 SUBSCRIBE 报文只含一个主题
    const topics = [
      TOPIC_PUSH_MESSAGE,
      TOPIC_NOTIFY_MESSAGE,
      TOPIC_GROUP_NOTIFY,
      TOPIC_FRIEND_NOTIFY,
      TOPIC_FRIEND_REQUEST,
      TOPIC_USER_SETTING,
      TOPIC_RECALL_NOTIFY,
      TOPIC_READ_NOTIFY,
      TOPIC_READ_DELIVERY,
    ];

    for (const topic of topics) {
      this.mqttClient.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          logger.error(`[MQTT] 订阅 ${topic} 失败:`, err.message);
        }
      });
    }
  }

  /**
   * 处理服务器推送消息（PUBLISH）
   * 
   * ★★★ 关键发现（源码确认）: 推送消息是明文 protobuf，不做 AES 解密！★★★
   * 源码: mqttClientInstance.on("message", function(e, t, n) {
   *   if ("MS" === e) { var o = Message.decode(t); ... }
   *   else if ("MN" === e) { var s = NotifyMessage.decode(t); ... }
   * })
   */
  _handlePushMessage(topic, payload) {
    if (logger.isDebugEnabled()) {
      logger.debug(`\n[MQTT] 收到推送, 主题: ${topic}, 大小: ${payload.length} bytes`);
    }

    // ★ 推送消息是明文 protobuf，直接解码
    // 但也尝试 AES 解密作为备选（有些服务器可能加密推送）
    let data = null;
    
    // 先尝试明文 protobuf 解码
    try {
      switch (topic) {
        case TOPIC_PUSH_MESSAGE:
          this._handlePushMessage_decode(payload);
          return;
        case TOPIC_NOTIFY_MESSAGE:
          this._handleNotifyMessage(payload);
          return;
        case TOPIC_GROUP_NOTIFY:
          this._handleGroupNotify(payload);
          return;
        case TOPIC_FRIEND_NOTIFY:
        case TOPIC_FRIEND_REQUEST:
        case TOPIC_USER_SETTING:
        case TOPIC_RECALL_NOTIFY:
        case TOPIC_READ_NOTIFY:
        case TOPIC_READ_DELIVERY:
          this._handleVersionNotification(topic, payload);
          return;
        default:
          logger.debug(`[MQTT] 未知推送主题: ${topic}`);
      }
    } catch (e) {
      logger.debug(`[MQTT] 明文解码失败 (${e.message})，尝试 AES 解密...`);
    }

    // 如果明文解码失败，尝试 AES 解密（兼容加密推送的服务器）
    try {
      const decrypted = this._decryptPushPayload(payload);
      if (decrypted) {
        switch (topic) {
          case TOPIC_PUSH_MESSAGE:
            this._handlePushMessage_decode(decrypted);
            break;
          case TOPIC_NOTIFY_MESSAGE:
            this._handleNotifyMessage(decrypted);
            break;
          case TOPIC_GROUP_NOTIFY:
            this._handleGroupNotify(decrypted);
            break;
          default:
            logger.debug(`[MQTT] 未知主题 (${topic}), 数据:`, decrypted.toString('hex').substring(0, 100));
        }
      }
    } catch (e2) {
      logger.error(`[MQTT] 处理推送消息失败 (${topic}):`, e2.message);
    }
  }

  /**
   * 解密推送载荷（备选方案，部分服务器可能加密推送）
   * 格式: [status_byte][AES加密的protobuf]
   */
  _decryptPushPayload(payload) {
    if (payload.length < 2) return null;
    // 跳过第一个字节（状态码），AES 解密
    const encryptedData = payload.slice(1).toString('base64');
    return aesDecrypt(encryptedData, this.privateSecret, true);
  }

  /**
   * 处理新消息推送（明文 protobuf）
   */
  _handlePushMessage_decode(payload) {
    const message = proto.decode('qxdim.Message', payload);
    const msgData = proto.toJSON(message);

    // ★ 热路径: 每条消息都会调用，debug 关闭时跳过所有昂贵的格式化
    if (logger.isDebugEnabled()) {
      logger.debug('\n========== 新消息 ==========');
      logger.debug('  消息ID:', msgData.messageId);
      logger.debug('  发送者:', msgData.fromUser);
      logger.debug('  会话类型:', msgData.conversation?.type);
      logger.debug('  目标:', msgData.conversation?.target);
      logger.debug('  时间:', new Date(Number(msgData.serverTimestamp)).toLocaleString());

      if (msgData.content) {
        logger.debug('  内容类型:', msgData.content.type);
        logger.debug('  可搜索内容:', msgData.content.searchableContent || '');
        logger.debug('  推送内容:', msgData.content.pushContent || '');
        logger.debug('  文本内容:', msgData.content.content || '');
        logger.debug('  媒体类型:', msgData.content.mediaType);
        logger.debug('  远程媒体:', msgData.content.remoteMediaUrl || '');
        logger.debug('  扩展数据:', msgData.content.extra || '');

        if (msgData.content.data) {
          try {
            const binaryStr = Buffer.from(msgData.content.data, 'base64').toString('utf8');
            logger.debug('  二进制内容(文本):', binaryStr.substring(0, 200));
            const jsonObj = JSON.parse(binaryStr);
            logger.debug('  二进制内容(JSON):', JSON.stringify(jsonObj, null, 2).substring(0, 500));
          } catch (e) {
            logger.debug('  二进制内容(原始):', msgData.content.data.substring(0, 100));
          }
        }
      }

      logger.debug('================================\n');
    }

    // ★★★ 先更新 lastMsgHead，再分发回调 → 防止并发 MN 拉取重复分发同一条消息
    if (msgData.messageId) {
      // ★ 单调性保护: 仅当 messageId > 当前 lastMsgHead 时才分发（跳过来自 pull 的重复消息）
      const isNew = !this.lastMsgHead || this.lastMsgHead === '0' ||
                    this._compareHead(msgData.messageId, this.lastMsgHead) > 0;
      if (isNew) {
        this.lastMsgHead = msgData.messageId;
      } else {
        if (logger.isDebugEnabled()) {
          logger.debug(`[MQTT] ⏭️ 跳过重复 push: messageId=${msgData.messageId} <= lastMsgHead=${this.lastMsgHead}`);
        }
        return;
      }
    }

    if (this.messageCallback) {
      // ★ 用户回调用 try/catch 包裹，防止回调异常向上传播
      try {
        this.messageCallback(msgData);
      } catch (e) {
        logger.error('[MQTT] messageCallback 异常:', e.message);
      }
    }
  }

  /**
   * 处理消息通知（明文 protobuf）
   */
  _handleNotifyMessage(payload) {
    const notify = proto.decode('qxdim.NotifyMessage', payload);
    const notifyData = proto.toJSON(notify);

    if (logger.isDebugEnabled()) {
      logger.debug('[MQTT] 消息通知 - type:', notifyData.type, 'head:', notifyData.head);
    }

    // ★★★ WildFireChat 拉取逻辑：
    //   MN 通知的 head 是"新的最新版本号"
    //   客户端应该用"上次已读的 head"作为 id 拉取，服务器返回 (id, head] 之间的消息
    //   用错 head（用新 head 拉）会返回空，因为新 head 之后没消息
    //   所以这里用 this.lastMsgHead（拉取起点），而不是 notifyData.head
    const pullFrom = this.lastMsgHead || 0;
    this._pullAndDispatch(pullFrom, notifyData.type, notifyData.head);

    if (this.notificationCallback) {
      // ★ 用户回调用 try/catch 包裹
      try {
        this.notificationCallback({ type: 'notify', data: notifyData });
      } catch (e) {
        logger.error('[MQTT] notificationCallback 异常:', e.message);
      }
    }
  }

  /**
   * 拉取消息并分发给回调，最后更新 lastMsgHead
   *
   * ★ 并发安全: 通过 _pullChain 串行化所有拉取请求。
   *   多个 MN 通知快速到达时，不会并发拉取导致:
   *   1. 重复分发（两次拉取用相同 fromHead，返回相同消息）
   *   2. lastMsgHead 竞态（两次更新互相覆盖）
   *   3. 消息乱序（后拉的先返回）
   *
   * @param {number|string} fromHead - 拉取起点（上次已读 head）
   * @param {number} type - 0=普通消息, 1=...
   * @param {number|string} [expectedNewHead] - 期望的新 head（来自 MN 通知），用于校验
   * @returns {Promise} 串行化链上的 promise（不会 reject，错误已内部捕获）
   */
  _pullAndDispatch(fromHead, type, expectedNewHead) {
    // ★ 串行化: 链式排队，等上一个拉取完成后再执行本次
    // 整个链吞掉 rejection，防止 fire-and-forget 调用产生 unhandledRejection
    this._pullChain = this._pullChain.then(() => this._doPull(fromHead, type, expectedNewHead))
      .catch((e) => {
        // _doPull 内部已有 try/catch，这里是兜底（如 Long import 失败等）
        logger.error('[MQTT] _pullAndDispatch 链异常:', e.message);
      });
    // ★ 每 1000 次拉取回收链，防止 Promise 链无限增长导致微任务遍历开销
    this._pullCount++;
    if (this._pullCount >= 1000) {
      this._pullCount = 0;
      this._pullChain = this._pullChain.then(() => {
        this._pullChain = Promise.resolve();
      });
    }
    return this._pullChain;
  }

  /**
   * 实际执行拉取（由 _pullAndDispatch 串行调用）
   */
  async _doPull(fromHead, type, expectedNewHead) {
    // ★ 串行化后再次检查: 如果 fromHead 已经 < lastMsgHead（前一次拉取已推进），
    //   说明本次拉取的起点已过时，跳过避免重复拉取
    //   fromHead == lastMsgHead 是正常情况——首次连接后的首次拉取，不应跳过
    if (this.lastMsgHead && String(fromHead) !== '0' &&
        this._compareHead(fromHead, this.lastMsgHead) < 0) {
      logger.debug(`[MQTT] 跳过过时拉取: from=${fromHead} < lastMsgHead=${this.lastMsgHead}`);
      return;
    }

    // ★ 静态 import Long（顶部已 import），无需 await import
    const requestPayload = {
      id: Long.fromString(String(fromHead)),
      type: type,
    };

    logger.debug(`[MQTT] 拉取: from=${fromHead} type=${type} expected=${expectedNewHead}`);

    try {
      const result = await this._publishWithResponse(
        TOPIC_PULL_MESSAGE, 'qxdim.PullMessageRequest', requestPayload, 'qxdim.PullMessageResult'
      );

      if (!result) return;

      const resultData = proto.toJSON(result);
      const messages = resultData.message || [];
      logger.debug(`[MQTT] ✅ 拉取 ${messages.length} 条, current=${resultData.current} head=${resultData.head}`);

      // 分发新消息（去重：跳过已被 push 分发过的 messageId）
      const debugEnabled = logger.isDebugEnabled();
      for (const msg of messages) {
        // ★ 单调性保护: messageId <= lastMsgHead 的消息已通过 push 分发，跳过
        if (msg.messageId && this.lastMsgHead && this.lastMsgHead !== '0' &&
            this._compareHead(msg.messageId, this.lastMsgHead) <= 0) {
          if (debugEnabled) {
            logger.debug(`[MQTT] ⏭️ 跳过重复 pull: messageId=${msg.messageId} <= lastMsgHead=${this.lastMsgHead}`);
          }
          continue;
        }
        if (this.messageCallback) {
          // ★ 用户回调用 try/catch 包裹，防止单条消息回调异常中断剩余消息分发
          try {
            this.messageCallback(msg);
          } catch (e) {
            logger.error('[MQTT] messageCallback 异常 (pull):', e.message);
          }
        }
        if (debugEnabled) {
          logger.debug(`[MQTT] 📩 消息: from=${msg.fromUser}, type=${msg.content?.type}, ` +
                      `text=${JSON.stringify(msg.content?.searchableContent || '').substring(0, 80)}`);
        }
      }

      // 更新 lastMsgHead 为最新 head（取 resultData.head，因为可能有旧的重复消息被跳过）
      if (resultData.head) {
        // ★ 单调性保护: 只在 head > 当前值时更新
        if (!this.lastMsgHead || this.lastMsgHead === '0' ||
            this._compareHead(resultData.head, this.lastMsgHead) > 0) {
          this.lastMsgHead = resultData.head;
          logger.debug(`[MQTT] lastMsgHead 更新为 ${this.lastMsgHead}`);
        }
      }
    } catch (e) {
      logger.error('[MQTT] 拉取消息失败:', e.message);
    }
  }

  /**
   * 比较两个 head 值的大小（支持 number/string/Long-like）
   * @returns {number} -1 if a<b, 0 if a==b, 1 if a>b
   */
  _compareHead(a, b) {
    // ★ 用 BigInt 比较，避免字符串字典序比较大数错误
    //   反例: "999999999999999999"(18位) 与 "1000000000000000000"(19位)
    //   数值上 a < b，但字符串字典序 '9' > '1' 会得出 a > b 的错误结果
    //   支持 number/string/Long-like（含 toString 方法的对象）
    const sa = (a != null && typeof a.toString === 'function') ? String(a) : '0';
    const sb = (b != null && typeof b.toString === 'function') ? String(b) : '0';
    try {
      const ba = BigInt(sa);
      const bb = BigInt(sb);
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    } catch (e) {
      // 极端回退: 非数字字符串，说明数据可能异常，记录警告
      logger.warn('[MQTT] _compareHead BigInt 比较失败，回退字符串比较:', e.message, `a="${sa}" b="${sb}"`);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
  }

  /**
   * 处理群组消息通知（明文 protobuf）
   */
  _handleGroupNotify(payload) {
    const notify = proto.decode('qxdim.NotifyGroupMessage', payload);
    const notifyData = proto.toJSON(notify);

    if (logger.isDebugEnabled()) {
      logger.debug('[MQTT] 群组通知 - target:', notifyData.target, 'head:', notifyData.head);
    }

    if (this.notificationCallback) {
      // ★ 用户回调用 try/catch 包裹
      try {
        this.notificationCallback({ type: 'group_notify', data: notifyData });
      } catch (e) {
        logger.error('[MQTT] notificationCallback 异常 (group):', e.message);
      }
    }
  }

  /**
   * 处理版本号通知（好友/设置/撤回/已读等）
   * 这些通知只有版本号，不需要拉取数据
   */
  _handleVersionNotification(topic, payload) {
    const topicNames = {
      [TOPIC_FRIEND_NOTIFY]: '好友变动',
      [TOPIC_FRIEND_REQUEST]: '好友请求',
      [TOPIC_USER_SETTING]: '用户设置',
      [TOPIC_RECALL_NOTIFY]: '撤回消息',
      [TOPIC_READ_NOTIFY]: '已读通知',
      [TOPIC_READ_DELIVERY]: '送达通知',
    };

    // 撤回通知有专门的 protobuf，需要解码并分发回调
    if (topic === TOPIC_RECALL_NOTIFY) {
      try {
        const notify = proto.decode('qxdim.NotifyRecallMessage', payload);
        const notifyData = proto.toJSON(notify);
        if (this.notificationCallback) {
          this.notificationCallback({ type: 'recall', data: notifyData });
        }
        if (logger.isDebugEnabled()) {
          logger.debug(`[MQTT] ${topicNames[topic] || topic} 通知: fromUser=${notifyData.fromUser}, messageId=${notifyData.id}`);
        }
        return;
      } catch (e) { /* 可能是简单版本号，fallthrough 到下面的 debug 日志 */ }
    }

    // ★ 热路径: hex 转储仅在 debug 时执行
    if (logger.isDebugEnabled()) {
      const info = `0x${payload.toString('hex').substring(0, 32)}`;
      logger.debug(`[MQTT] ${topicNames[topic] || topic} 通知: ${info}`);
    }
  }

  // ==================== 请求/响应模式 ====================
  // 
  // WildFireChat 的请求-响应模式:
  //   1. 客户端 PUBLISH(topic, AESEncrypt(protobuf, privateSecret))
  //   2. 服务器返回 PUBACK + [status_byte][AESEncrypt(protobuf, privateSecret)]
  //   3. PUBACK 通过 monkey-patch 的 Parser 提取 payload
  //   4. _publishWithResponse() 通过 publish callback 接收响应
  //

  /**
   * 拉取消息
   * @param {number|string} head - 消息版本号
   * @param {number} type - 拉取类型
   * @returns {Promise<object|null>} PullMessageResult 或 null
   */
  async pullMessages(head, type) {
    if (!this.privateSecret) {
      logger.warn('[MQTT] 尚未获取 privateSecret，无法发送请求');
      return null;
    }

    // ★ 静态 import Long（顶部已 import），无需 await import
    const requestPayload = {
      id: Long.fromString(String(head)),
      type: type,
    };

    logger.debug('[MQTT] 发送拉取消息请求, head:', head, 'type:', type);
    
    try {
      const result = await this._publishWithResponse(TOPIC_PULL_MESSAGE, 'qxdim.PullMessageRequest', requestPayload, 'qxdim.PullMessageResult');
      
      if (result) {
        const resultData = proto.toJSON(result);
        logger.debug('[MQTT] ✅ 拉取消息成功! 消息数:', resultData.message?.length || 0, 
                    'current:', resultData.current, 'head:', resultData.head);
        
        // 处理拉取到的消息（去重：跳过已被 push 分发过的 messageId）
        if (resultData.message && resultData.message.length > 0) {
          const debugEnabled = logger.isDebugEnabled();
          for (const msg of resultData.message) {
            if (msg.messageId && this.lastMsgHead && this.lastMsgHead !== '0' &&
                this._compareHead(msg.messageId, this.lastMsgHead) <= 0) {
              if (debugEnabled) {
                logger.debug(`[MQTT] ⏭️ 跳过重复 pullMessages: messageId=${msg.messageId} <= lastMsgHead=${this.lastMsgHead}`);
              }
              continue;
            }
            if (this.messageCallback) {
              // ★ 用户回调用 try/catch 包裹
              try {
                this.messageCallback(msg);
              } catch (e) {
                logger.error('[MQTT] messageCallback 异常 (pullMessages):', e.message);
              }
            }
            if (debugEnabled) {
              logger.debug(`[MQTT] 📩 消息: from=${msg.fromUser}, type=${msg.content?.type}, content=${msg.content?.content?.substring(0, 50)}`);
            }
          }
        }

        // 更新版本号
        if (this.routeInfo && resultData.head) {
          if (type === 0) this.routeInfo.msgHead = resultData.head;
        }

        return resultData;
      }
    } catch (e) {
      logger.error('[MQTT] 拉取消息失败:', e.message);
    }
    
    return null;
  }

  /**
   * 发送消息
   * @param {object} conversation - 会话信息 {type, target, line}
   * @param {object} content - 消息内容
   * @returns {Promise<object|null>} {messageUid, timestamp} 或 null
   */
  async sendMessage(conversation, content) {
    const messagePayload = {
      conversation: conversation,
      fromUser: this.userId,
      content: content,
    };

    logger.debug('[MQTT] 发送消息到:', conversation.target);

    try {
      const response = await this._publishWithResponse(TOPIC_SEND_MESSAGE, 'qxdim.Message', messagePayload);
      
      if (response && response.payload) {
        // ★ WildFireChat sendMessage 响应: 16 字节 raw [8B messageUid BE][8B timestamp BE(ms)]
        //   注意: 大端序 (BE)，不是小端！
        //   messageUid 是全局唯一消息 ID (与 ConnectAckPayload.msgHead 同数量级)
        //   timestamp 是 13 位毫秒时间戳
        const respPayload = response.payload;

        if (respPayload.length >= 16) {
          const messageUid = respPayload.slice(0, 8);    // 8 bytes BE int64
          const timestamp = respPayload.slice(8, 16);    // 8 bytes BE int64 (ms)
          const messageUidLong = messageUid.readBigInt64BE(0);
          const timestampLong = timestamp.readBigInt64BE(0);
          // ★ 热路径: hex 转储仅在 debug 时执行
          if (logger.isDebugEnabled()) {
            logger.debug('[MQTT] sendMessage 响应:', respPayload.length, 'bytes, hex:', respPayload.toString('hex'));
            logger.debug('[MQTT] ✅ 消息发送成功, messageUid:', messageUidLong.toString(),
                        '(' + messageUid.toString('hex') + '), timestamp:', new Date(Number(timestampLong)).toISOString());
          }
          return { messageUid, timestamp, messageUidLong, timestampLong, raw: respPayload };
        }
      }
    } catch (e) {
      logger.error('[MQTT] 发送消息失败:', e.message);
    }
    
    return null;
  }

  /**
   * ★★★ 核心方法: 发送请求并接收 PUBACK 响应 ★★★
   * 
   * 流程:
   *   1. Protobuf 编码请求数据
   *   2. AES 加密
   *   3. mqttClient.publish() 发送
   *   4. 服务器返回 PUBACK，通过 monkey-patch 提取 payload
   *   5. 解密响应 payload
   *   6. Protobuf 解码响应
   * 
   * @param {string} topic - MQTT 主题
   * @param {string} requestType - 请求 protobuf 类型名
   * @param {object} requestPayload - 请求数据
   * @param {string} [responseType] - 响应 protobuf 类型名（可选，MS 的响应是原始字节）
   * @returns {Promise<object>} 解码后的响应或包含 payload 的 packet
   */
  _publishWithResponse(topic, requestType, requestPayload, responseType) {
    return new Promise((resolve, reject) => {
      if (!this.mqttClient) {
        reject(new Error('MQTT 未连接'));
        return;
      }

      // ★ 提前捕获解密密钥为局部变量，避免 Promise 闭包通过 this 长期持有凭据
      //   disconnect() 后 this.tokenKey/privateSecret 会被清理，但 pending Promise
      //   的闭包仍持有本副本（最长 30 秒超时窗口），用于解密可能延迟到达的响应
      const decryptKey = this.tokenKey || this.privateSecret;
      const privateSecretLen = this.privateSecret ? this.privateSecret.length : 0;

      // 1. Protobuf 编码
      const requestBytes = proto.encode(requestType, requestPayload);
      // ★ 热路径: hex 转储昂贵，仅 debug 开启时执行
      if (logger.isDebugEnabled()) {
        logger.debug(`[MQTT] _publishWithResponse: ${topic}, 请求大小: ${requestBytes.length} bytes`);
        logger.debug(`[MQTT] protobuf hex: ${Buffer.from(requestBytes).toString('hex').substring(0, 100)}`);
      }

      // 2. AES 加密
      const encrypted = this._encryptPayload(requestBytes);
      if (logger.isDebugEnabled()) {
        logger.debug(`[MQTT] 加密后大小: ${encrypted.length} bytes, privateSecret长度: ${privateSecretLen}`);
        logger.debug(`[MQTT] 加密后 hex: ${encrypted.toString('hex').substring(0, 100)}`);
      }

      // 超时保护：防止服务器不回 PUBACK 时永久挂起
      const PUBLISH_TIMEOUT_MS = 30000;
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`[MQTT] ${topic} 请求超时 (${PUBLISH_TIMEOUT_MS}ms)`));
      }, PUBLISH_TIMEOUT_MS);

      // 3. 发送，等待 PUBACK 响应
      // ★★★ 关键: 浏览器客户端用 {qos:1, retain:true, dup:true} ★★★
      // WildFireChat 服务端可能检查 retain 标志，缺少会导致 status=2
      this.mqttClient.publish(topic, encrypted, { qos: 1, retain: true, dup: true }, (err, packet) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);

        if (err) {
          logger.error(`[MQTT] publish ${topic} 错误:`, err.message);
          reject(err);
          return;
        }

        logger.debug(`[MQTT] 收到 ${topic} PUBACK, packet.cmd:`, packet?.cmd);

        // ★★★ WildFireChat: 响应数据在 packet.payload 中 ★★★
        if (!packet || !packet.payload || packet.payload.length === 0) {
          logger.warn(`[MQTT] ${topic} PUBACK 无 payload（标准 MQTT 行为，可能 patch 未生效）`);
          // 尝试直接把 packet 当作响应
          resolve(null);
          return;
        }

        const payload = packet.payload;
        logger.debug(`[MQTT] ${topic} PUBACK payload: ${payload.length} bytes, status=${payload[0]}`);

        // 4. 解密响应 (用提前捕获的 decryptKey，与加密时一致)
        const { status, data, compressed } = decryptMqttResponse(payload, decryptKey);

        if (status !== 0 && status !== 5 && status !== 255) {
          logger.error(`[MQTT] ${topic} 响应错误码:`, status);
          reject(new Error(`服务器错误码: ${status}`));
          return;
        }

        if (!data) {
          logger.debug(`[MQTT] ${topic} 响应无数据`);
          resolve(null);
          return;
        }

        // 5. 解压缩（如果需要）
        // ★ 加 5MB 解压上限防止 zip bomb 攻击
        const MAX_INFLATE_BYTES = 5 * 1024 * 1024;
        let finalData = data;
        if (compressed) {
          try {
            finalData = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATE_BYTES });
            logger.debug(`[MQTT] ${topic} 响应已解压: ${data.length} → ${finalData.length} bytes`);
          } catch (e) {
            logger.warn(`[MQTT] ${topic} 解压失败:`, e.message);
          }
        }

        // 6. Protobuf 解码
        if (responseType) {
          try {
            const response = proto.decode(responseType, finalData);
            resolve(response);
          } catch (e) {
            logger.error(`[MQTT] ${topic} 解码 ${responseType} 失败:`, e.message);
            if (logger.isDebugEnabled()) {
              // ★ 只截取前 32 字节做 hex 转储，避免大量数据转 hex 和敏感内容泄漏
              logger.debug(`[MQTT] 原始数据(hex前32字节):`, finalData.subarray(0, 32).toString('hex'));
              logger.debug(`[MQTT] 原始数据长度: ${finalData.length} bytes`);
            }
            reject(e);
          }
        } else {
          // 不解码，返回原始 packet（如 MS 响应是 16 字节 raw data）
          resolve({ payload: finalData });
        }
      });
    });
  }

  /**
   * 加密载荷
   * @param {Uint8Array} data - 原始数据
   * @returns {Buffer} 加密后的 Buffer
   */
  _encryptPayload(data) {
    // ★ WildFireChat 业务消息 (PullMessage, SendMessage 等) 必须用 tokenKey (UUID1) 加密
    //   privateSecret (UUID2) 用于解密 push message (服务器主动推送)
    //   用 privateSecret 加密 request 会导致 status=2 错误码——不回退，直接报错
    if (!this.tokenKey) {
      throw new Error('[MQTT] tokenKey 为空，无法加密请求载荷（业务消息只能用 tokenKey 加密，不能用 privateSecret 回退）');
    }
    const base64 = aesEncrypt(data, this.tokenKey, true);
    return Buffer.from(base64, 'base64');
  }

  /**
   * 更新连接状态
   * ★ 状态去重: 相同状态不重复回调，避免 offline/close 等多个事件触发重复输出
   */
  _updateStatus(status) {
    if (this.status === status) return;
    this.status = status;
    const statusNames = {
      [ConnectionStatus.UNCONNECTED]: '未连接',
      [ConnectionStatus.CONNECTING]: '连接中',
      [ConnectionStatus.CONNECTED]: '已连接',
      [ConnectionStatus.RECEIVING]: '接收中',
      [ConnectionStatus.KICKED_OFF]: '被踢下线',
    };
    logger.debug(`[MQTT] 状态: ${statusNames[status] || status}`);
    if (this.statusCallback) {
      this.statusCallback(status);
    }
  }

  /**
   * 设置 privateSecret（会话密钥）
   */
  setPrivateSecret(secret) {
    this.privateSecret = secret;
    logger.debug('[MQTT] 已设置会话密钥');
  }

  /**
   * 断开连接（不重连）
   * ★ async: 等待 mqttClient.end(true) 完成后再返回，确保连接真正关闭
   * ★ 重置 _pullChain: 防止断开后 pending 拉取仍执行 _doPull 触发 "MQTT 未连接" 错误
   * ★ 清理凭据: tokenKey/privateSecret 置空，防止内存驻留（pending Promise 闭包持有副本不可避免）
   */
  async disconnect() {
    // ★ 主动断开: 关闭自动重连，再 end
    this.shouldReconnect = false;
    if (this.mqttClient) {
      this.mqttClient.removeAllListeners();
      // ★ 等待 end 完成: end(true) 强制关闭，不等待 in-flight 消息
      //   mqtt.js end(force, cb) 接受回调；包装为 Promise 确保连接真正关闭
      //   end(true) 会清理 outStore 中的 QoS 1 消息，避免超时后 outStore 泄漏
      //   加 5 秒超时防护: 底层 socket 已损坏时 end() 可能永不回调
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          logger.warn('[MQTT] disconnect end() 超时 (5s)，强制清理');
          resolve();
        }, 5000);
        this.mqttClient.end(true, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.mqttClient = null;
    }
    // ★ 重置拉取链: 防止断开后 pending 的 _doPull 执行时 mqttClient 已 null
    this._pullChain = Promise.resolve();
    // ★ 清理敏感凭据（disconnect 是不重连的最终断开，可安全清理）
    //   注意: pending 的 _publishWithResponse Promise 闭包仍持有 decryptKey 副本，
    //   最长 30 秒超时后释放，这是不可避免的（需要密钥解密可能延迟到达的响应）
    this.tokenKey = '';
    this.privateSecret = '';
    this.connectParams = null;
    this._updateStatus(ConnectionStatus.UNCONNECTED);
    logger.debug('[MQTT] 已断开连接');
  }

  /**
   * ★ 手动触发重连（用于 token 刷新后重新连接）
   *   先 end 当前连接，再重新建立
   */
  async reconnectWithNewCredentials(newParams) {
    logger.debug('[MQTT] 手动重连: 使用新凭据');
    this.shouldReconnect = false;
    if (this.mqttClient) {
      this.mqttClient.removeAllListeners();
      // ★ await end() 确保旧连接完全关闭后再建新连接，避免新旧 client 竞态
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          logger.warn('[MQTT] reconnectWithNewCredentials end() 超时 (5s)，强制清理');
          resolve();
        }, 5000);
        this.mqttClient.end(true, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.mqttClient = null;
    }
    if (newParams) {
      if (!this.connectParams) {
        throw new Error('[MQTT] reconnectWithNewCredentials: connectParams 为空，请先调用 connect()');
      }
      // 更新连接参数 (例如新的 password = AES(tokenPart1, newTokenKey))
      this.connectParams = { ...this.connectParams, ...newParams };
    }
    this.reconnectAttempt = 0;
    this._lastReconnectTime = 0;
    // ★ 重连后恢复 shouldReconnect 状态（让自动重连继续生效）
    this.shouldReconnect = this.autoReconnect;
    this._pullChain = Promise.resolve();
    this._setupMqttConnection();
  }
}
