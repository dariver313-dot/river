import WebSocket from 'ws';
import { logger } from './logger';

export interface WithdrawOrder {
  orderNo: string;
  status: number;
  amount: string | number;
  memberName?: string;
  member_name?: string;
  memberId?: string;
  member_id?: string;
  createTime?: string | number;
  proxyCode?: string;
  proxy_code?: string;
  agencyMemberName?: string;
  receivingBank?: string;
  receivingName?: string;
  receivingCardNo?: string;
  vipLevel?: string | number;
  currency?: string;
  balance?: string | number;
  sumWithdraw?: string | number;
  sumRecharge?: string | number;
  memberRemark?: string;
  id?: string | number;
  [key: string]: unknown;
}

export type WithdrawHandler = (order: WithdrawOrder, action: 'new' | 'update') => void;

interface WsConfig {
  url: string;
  token: () => string | null | Promise<string | null>;
  onWithdraw: WithdrawHandler;
  onConnect?: () => void;
}

export class WsClient {
  private config: WsConfig;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 30;
  private isConnected = false;
  private isStopped = false;
  private lastHeartbeatTime = 0;

  constructor(config: WsConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  updateUrl(url: string): void {
    this.config.url = url;
  }

  async connect(): Promise<void> {
    if (this.isStopped) return;

    // 先清理旧连接，避免孤儿 WebSocket
    this.softDisconnect();

    const token = await this.config.token();
    if (!token) {
      logger.warn('[WS] Token 不可用，使用指数退避重试连接');
      this.scheduleReconnect();
      return;
    }

    if (!this.config.url) {
      logger.warn('[WS] 无可用域名，使用指数退避重试连接');
      this.scheduleReconnect();
      return;
    }

    const baseUrl = this.config.url.replace(/\/+$/, '');
    const url = `${baseUrl}/liveOperatorWs/${token}`;
    logger.info({ url: `${baseUrl}/liveOperatorWs/***` }, '[WS] 正在连接...');

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[WS] 创建连接失败');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempt = 0;
      this.lastHeartbeatTime = Date.now();
      logger.info('[WS] ✅ 已连接');
      this.startHeartbeat();
      this.config.onConnect?.();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', (code: number, reason: string) => {
      this.isConnected = false;
      this.stopHeartbeat();
      logger.warn({ code, reason: reason?.toString() || 'unknown' }, '[WS] 连接关闭');
      if (!this.isStopped) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err: err.message }, '[WS] 连接错误');
    });
  }

  softDisconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'reconnect');
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {}
    }
    this.isConnected = false;
  }

  disconnect(): void {
    this.isStopped = true;
    this.softDisconnect();
    logger.info('[WS] 已断开连接（永久）');
  }

  resetReconnect(): void {
    this.reconnectAttempt = 0;
    this.isStopped = false;
  }

  private handleMessage(raw: string): void {
    this.lastHeartbeatTime = Date.now();

    if (raw === 'pong' || raw === 'PONG') {
      return;
    }

    try {
      const msg = JSON.parse(raw);

      if (msg.ctrlType === 101) {
        let order: WithdrawOrder;
        try {
          order = typeof msg.Msg === 'string' ? JSON.parse(msg.Msg) : msg.Msg;
        } catch (err) {
          logger.warn({ msg: JSON.stringify(msg).substring(0, 300), err: (err as Error).message }, '[WS] 订单消息内层JSON解析失败');
          return;
        }
        if (!order || !order.orderNo) {
          logger.debug({ msg: JSON.stringify(msg).substring(0, 200) }, '[WS] 推送消息缺少 orderNo，跳过');
          return;
        }

        if (order.status === 1) {
          this.config.onWithdraw(order, 'new');
        } else {
          logger.debug({ orderNo: order.orderNo, status: order.status }, '[WS] 订单状态变更推送');
          this.config.onWithdraw(order, 'update');
        }
      }
    } catch (err) {
      logger.debug({ raw: raw.substring(0, 200), err: (err as Error).message }, '[WS] 非JSON消息或解析失败');
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const elapsed = Date.now() - this.lastHeartbeatTime;
        if (elapsed > 120000) {
          logger.warn({ elapsedSec: Math.round(elapsed / 1000) }, '[WS] 心跳超时，终止连接');
          this.ws.terminate();
          return;
        }
        this.ws.send('ping');
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(delay?: number): void {
    if (this.isStopped) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      logger.error({ attempts: this.reconnectAttempt }, '[WS] 重连次数耗尽，停止重连');
      this.isStopped = true;
      return;
    }

    const baseDelay = delay ?? Math.min(1000 * Math.pow(2, this.reconnectAttempt), 32000);
    this.reconnectAttempt++;
    logger.info({ attempt: this.reconnectAttempt, delayMs: baseDelay }, `[WS] ${baseDelay / 1000}秒后重连 (${this.reconnectAttempt}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, baseDelay);
  }
}
