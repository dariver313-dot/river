import { createServer } from './server';
import path from 'path';
import dotenv from 'dotenv';
import { LRUCache } from 'lru-cache';
import { apiClient } from './api-client';
import { evaluateOrder, updateMemberProfile, updateAgentProfile, recordSuccessfulWithdrawal, setPrefetchStore, consumePrefetchedDetail, getCacheStats } from './evaluator';
import { extractProxyCode, formatBeijingTime, parseTimeStr } from './utils';
import { startTelegramBot, sendRiskAlert, autoReviewExpiredOrders, scheduleAutoReview } from './telegram';
import { dbHolder, ensureDatabase } from './db';
import { getActiveRuleIds, applyRuleStates } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import { logger } from './logger';
import { WsClient, type WithdrawOrder } from './ws-client';
import * as auth from './auth-client';
import { reloadConstantsFromDB, reloadConstantsFromEnv } from './constants';
import type { TriggeredRule, UserDetailsResponse } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildDetailJson(order: WithdrawOrder, result?: EvaluationResult | null, extra?: Record<string, any>): string {
  const proxyCode = extractProxyCode(order) || result?.proxyCode || '';
  const receivingName = order?.receivingName || '';
  const detail: Record<string, any> = {
    orderAmount: order.amount,
    orderCurrency: order.currency || 'CNY',
    orderTime: order.createTime || order.createdAt,
    proxyCode,
    receivingBank: order.receivingBank,
    receivingName,
    receivingCardNo: order.receivingCardNo,
    vipLevel: order.vipLevel,
    balance: result?.balance ?? order.balance ?? '',
    registerTime: result?.registerTime || '',
    daysSinceReg: result?.daysSinceReg ?? 999,
    depositCount: result?.depositCount ?? 0,
    withdrawCount: result?.withdrawCount ?? 0,
    rechargeWithdrawDiff: result?.rechargeWithdrawDiff ?? 0,
    rechargeAmount: result?.rechargeAmount ?? 0,
    withdrawAmount: result?.withdrawAmount ?? 0,
    profitLoss: result?.profitLoss,
    estimatedProfitLoss: result?.estimatedProfitLoss ?? true,
    dataIssues: result?.dataIssues || [],
    isEarlyMorning: result?.isEarlyMorning || false,
    mainGameType: result?.mainGameType || '',
    remark: result?.remark || String(order.memberRemark || ''),
  };
  if (result?.triggeredRules) {
    // 优先使用 lhc-checker 生成的完整 periodInfo
    if (result.periodInfo) {
      detail.periodInfo = result.periodInfo;
    } else {
      const bettingRules = result.triggeredRules.filter((r: TriggeredRule) => ['R24', 'R25', 'R26', 'R27'].includes(r.id));
      if (bettingRules.length > 0) {
        detail.periodInfo = bettingRules.map((r: TriggeredRule) => `${r.id}:${r.reason.replace(/\n/g, ' | ')}`).join('|');
      }
    }
  }
  if (extra) Object.assign(detail, extra);
  return JSON.stringify(detail);
}

const EVAL_FAILED_RULE_ID = 'EVAL_FAILED';
const SYNTHETIC_RULE_IDS = new Set([EVAL_FAILED_RULE_ID]);

function buildFallbackResult(order: WithdrawOrder, orderNo?: string, reason = '风控数据查询失败，需人工复核'): EvaluationResult {
  const no = orderNo || String(order.orderNo || order.id || '');
  return {
    orderId: no,
    memberId: String(order.memberId || order.member_id || ''),
    memberName: order.memberName || order.member_name || '',
    totalScore: 30,
    riskLevel: 'HIGH',
    triggeredRules: [{
      id: EVAL_FAILED_RULE_ID,
      name: '风控评估失败',
      severity: 'HIGH',
      group: 'environment',
      reason,
      score: 30,
      presentation: 'core',
    }],
    groupScores: { environment: 30 },
    depositCount: 0,
    withdrawCount: 0,
    registerTime: '',
    daysSinceReg: 0,
    rechargeWithdrawDiff: 0,
    proxyCode: extractProxyCode(order),
    orderAmount: String(order.amount || ''),
    balance: String(order.balance ?? ''),
    remark: String(order.memberRemark || ''),
    isEarlyMorning: false,
  };
}

function getReplayableRules(
  rawRules: TriggeredRule[],
  activeRuleIds: Set<string>,
): TriggeredRule[] {
  return rawRules.filter((r) => activeRuleIds.has(r.id) || SYNTHETIC_RULE_IDS.has(r.id));
}

let POLL_INTERVAL = 60 * 1000;
let PORT = 0;
let HOST = '127.0.0.1';
let WS_ENABLED = true;
let WS_URL = '';
let POLL_INTERVAL_WS_CONNECTED = 30 * 1000;

const evaluatedOrderCache = new LRUCache<string, boolean>({ max: 2000, ttl: 2 * 60 * 60 * 1000 });
const evalRetryCount = new LRUCache<string, { count: number; source: string; ts: number }>({
  max: 2000,
  ttl: 10 * 60 * 1000,
});
const MAX_EVAL_RETRY = 3;

function incrementEvalRetry(orderNo: string, source: string): number {
  const key = `${orderNo}:${source}`;
  const existing = evalRetryCount.get(key);
  const newCount = (existing?.count || 0) + 1;
  evalRetryCount.set(key, { count: newCount, source, ts: Date.now() });
  return newCount;
}

function markEvaluated(orderNo: string): void {
  evaluatedOrderCache.set(orderNo, true);
  // 清除所有 source 的重试计数
  for (const source of ['ws', 'poll', 'polling', 'recovery', 'recovery-retry']) {
    evalRetryCount.delete(`${orderNo}:${source}`);
  }
}

let wsClient: WsClient | null = null;

type NotifyResult = 'sent' | 'skipped' | 'failed';

const noOrderNoNotifySet = new Set<string>();

// 防止同一订单并发通知：将 orderNo 串行化，CAS 之外的额外保护层
const notifyingLocks = new Map<string, Promise<NotifyResult>>();
const recentNotifications = new LRUCache<string, number>({ max: 1000, ttl: 5 * 60 * 1000 });
const NOTIFICATION_LEASE_MS = 10 * 60 * 1000;

type NotificationLeaseResult = 'acquired' | 'notified' | 'busy' | 'missing';

function wasRecentlyNotified(orderNo: string): boolean {
  return recentNotifications.has(orderNo);
}

function markRecentlyNotified(orderNo: string): void {
  recentNotifications.set(orderNo, Date.now());
}

async function acquireNotificationLease(orderNo: string): Promise<NotificationLeaseResult> {
  const now = new Date();
  const expiredBefore = new Date(now.getTime() - NOTIFICATION_LEASE_MS);
  const acquired = await dbHolder.db.riskEval.updateMany({
    where: {
      orderId: orderNo,
      notified: false,
      OR: [
        { notifyLeaseAt: null },
        { notifyLeaseAt: { lt: expiredBefore } },
      ],
    },
    data: { notifyLeaseAt: now },
  });
  if (acquired.count > 0) return 'acquired';

  const current = await dbHolder.db.riskEval.findUnique({
    where: { orderId: orderNo },
    select: { notified: true, notifyLeaseAt: true },
  });
  if (!current) return 'missing';
  if (current.notified) return 'notified';

  logger.info({ orderNo, notifyLeaseAt: current.notifyLeaseAt }, '[通知] 上次发送尚未确认，等待租约到期后再试');
  return 'busy';
}

async function releaseNotificationLease(orderNo: string): Promise<void> {
  await dbHolder.db.riskEval.updateMany({
    where: { orderId: orderNo, notified: false },
    data: { notifyLeaseAt: null },
  });
}

async function handleNotification(order: WithdrawOrder, result: EvaluationResult, precheckedNotified?: boolean): Promise<NotifyResult> {
  const orderNo = String(order.orderNo || order.id || result.orderId || '');
  if (!orderNo) {
    const dedupKey = `${result.memberId}:${result.orderAmount}:${result.triggeredRules.map((r: TriggeredRule) => r.id).join(',')}`;
    if (noOrderNoNotifySet.has(dedupKey)) return 'skipped';
    noOrderNoNotifySet.add(dedupKey);
    try {
      const r = await sendRiskAlert(result, order);
      return r.success ? 'sent' : 'failed';
    } finally {
      noOrderNoNotifySet.delete(dedupKey);
    }
  }

  if (precheckedNotified === true) return 'skipped';

  // 同一订单串行化通知：防止 WS 和轮询并发评估时重复发送
  if (orderNo) {
    const inflight = notifyingLocks.get(orderNo);
    if (inflight) {
      logger.info({ orderNo }, '[通知] 订单正在通知中，等待前序完成');
      return inflight;
    }
  }

  const doNotify = async (): Promise<NotifyResult> => {
    if (wasRecentlyNotified(orderNo)) return 'skipped';

    let leaseAcquired = false;
    try {
      const lease = await acquireNotificationLease(orderNo);
      if (lease === 'notified') {
        markRecentlyNotified(orderNo);
        return 'skipped';
      }
      if (lease === 'busy') return 'skipped';
      if (lease === 'missing') {
        logger.error({ orderNo }, '[通知] 找不到持久化风控记录，拒绝发送以避免不可追踪的重复通知');
        return 'failed';
      }
      leaseAcquired = true;
    } catch (err) {
      // 数据库不可用时保留原有的“优先通知”行为；恢复后租约会继续减少重复窗口。
      logger.warn({ orderNo, err: (err as Error).message }, '[通知] 发送租约获取失败，走受限乐观发送路径');
    }

    const { success: notified, messageId } = await sendRiskAlert(result, order);
    if (!notified) {
      if (leaseAcquired) {
        await releaseNotificationLease(orderNo).catch((err) => {
          logger.warn({ orderNo, err: (err as Error).message }, '[通知] 发送失败后释放租约失败');
        });
      }
      return 'failed';
    }

    markRecentlyNotified(orderNo);

    let marked = false;
    try {
      const r = await dbHolder.db.riskEval.updateMany({
        where: { orderId: orderNo, notified: false },
        data: {
          notified: true,
          notifyLeaseAt: null,
          ...(messageId !== undefined ? { notifyMsgId: messageId, notifiedAt: new Date() } : {}),
        },
      });
      marked = r.count > 0;
      if (r.count === 0) {
        logger.info({ orderNo }, '[通知] CAS显示已被其他路径标记，通知已发送');
      }
    } catch (err) {
      logger.warn({ orderNo, err: (err as Error).message }, '[通知] CAS标记notified失败，但通知已发送');
    }

    if (messageId !== undefined && marked) {
      // 精准定时：当前风险通知均带审核按钮，需要 2分30秒后自动审核。
      scheduleAutoReview(orderNo);
    }

    return 'sent';
  };

  const promise = doNotify();
  notifyingLocks.set(orderNo, promise);
  try {
    return await promise;
  } finally {
    notifyingLocks.delete(orderNo);
  }
}

let trackOrderRoundRobinOffset = 0;

async function retryPendingNotifications(): Promise<void> {
  try {
    const totalCount = await dbHolder.db.riskEval.count({ where: { notified: false, finalStatus: '' } });
    if (totalCount === 0) return;

    const BATCH_SIZE = 50;
    // 确定性轮转偏移：每轮递增一批，确保所有订单都能被覆盖，不会因随机跳过永久遗漏
    const totalBatches = Math.max(1, Math.ceil(totalCount / BATCH_SIZE));
    const skip = (trackOrderRoundRobinOffset % totalBatches) * BATCH_SIZE;
    trackOrderRoundRobinOffset = (trackOrderRoundRobinOffset + 1) % totalBatches;

    const unnotifiedEvals = await dbHolder.db.riskEval.findMany({
      where: { notified: false, finalStatus: '' },
      take: BATCH_SIZE,
      skip: skip,
      orderBy: { createdAt: 'desc' },
    });

    if (unnotifiedEvals.length === 0) return;

    logger.info({ count: unnotifiedEvals.length }, '[追踪] 发现未通知的风险订单，尝试补发');

    const activeRuleIds = getActiveRuleIds();
    const results: PromiseSettledResult<NotifyResult>[] = new Array(unnotifiedEvals.length);
    const REPLAY_NOTIFY_CONCURRENCY = parsePositiveInt(process.env.REPLAY_NOTIFY_CONCURRENCY, 5);
    let replayIdx = 0;

    const replayWorkers = Array.from({ length: Math.min(REPLAY_NOTIFY_CONCURRENCY, unnotifiedEvals.length) }, async () => {
      while (replayIdx < unnotifiedEvals.length) {
        const idx = replayIdx++;
        const evalRecord = unnotifiedEvals[idx];
        let detail: Record<string, unknown> = {};
        try { detail = JSON.parse(evalRecord.detail || '{}'); } catch {}
        let rawRules: TriggeredRule[] = [];
        try { rawRules = JSON.parse(evalRecord.triggeredRules || '[]'); } catch { rawRules = []; }
        const validRules = getReplayableRules(rawRules, activeRuleIds);
        try {
          const value = await handleNotification(
            {
              orderNo: evalRecord.orderId,
              status: 1,
              memberName: evalRecord.memberName,
              member_name: evalRecord.memberName,
              memberId: evalRecord.memberId,
              member_id: evalRecord.memberId,
              memberRemark: (detail.remark as string) || '',
              amount: (detail.orderAmount as string | number) || 0,
              proxyCode: (detail.proxyCode as string) || '',
              receivingBank: (detail.receivingBank as string) || '',
              receivingName: (detail.receivingName as string) || '',
              balance: (detail.balance as string | number) || '',
              createTime: (detail.orderTime as string | number) || '',
              vipLevel: (detail.vipLevel as string | number) || '',
            } as WithdrawOrder,
            {
              ...evalRecord,
              proxyCode: (detail.proxyCode as string) || '',
              orderAmount: (detail.orderAmount as string | number) || '',
              balance: (detail.balance as string | number) || '',
              registerTime: (detail.registerTime as string) || '',
              depositCount: (detail.depositCount as number) ?? 0,
              withdrawCount: (detail.withdrawCount as number) ?? 0,
              rechargeWithdrawDiff: (detail.rechargeWithdrawDiff as number) ?? 0,
              rechargeAmount: (detail.rechargeAmount as number) ?? 0,
              withdrawAmount: (detail.withdrawAmount as number) ?? 0,
              profitLoss: detail.profitLoss as number | undefined,
              estimatedProfitLoss: (detail.estimatedProfitLoss as boolean) ?? true,
              triggeredRules: validRules,
              groupScores: {},
              daysSinceReg: (detail.daysSinceReg as number) ?? 0,
              isEarlyMorning: (detail.isEarlyMorning as boolean) || false,
              mainGameType: (detail.mainGameType as string) || undefined,
              dataIssues: (detail.dataIssues as string[]) || [],
              remark: (detail.remark as string) || '',
            } as EvaluationResult,
            false
          );
          results[idx] = { status: 'fulfilled', value };
        } catch (reason) {
          results[idx] = { status: 'rejected', reason };
        }
      }
    });
    await Promise.all(replayWorkers);

    // H4: 补发完成后写入 evaluatedOrderCache，减少后续轮询周期的 DB 查询
    for (let i = 0; i < unnotifiedEvals.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value !== 'failed') {
        markEvaluated(unnotifiedEvals[i].orderId);
      }
    }

    const sent = results.filter(r => r.status === 'fulfilled' && r.value === 'sent').length;
    const skipped = results.filter(r => r.status === 'fulfilled' && r.value === 'skipped').length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value === 'failed')).length;
    if (failed > 0) {
      const failedIds = unnotifiedEvals
        .filter((_, i) => results[i].status === 'rejected' || (results[i].status === 'fulfilled' && results[i].value === 'failed'))
        .map(e => e.orderId);
      logger.warn({ failedIds }, '[追踪] 部分补发通知失败');
    }
    if (skipped > 0 || failed > 0 || sent > 0) {
      logger.info({ sent, skipped, failed, total: unnotifiedEvals.length }, '[追踪] 补发通知完成');
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[追踪] 补发通知检查失败');
  }
}

let isPolling = false;
let lastPollTime = 0;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const RECENT_ORDER_RECONCILE_WINDOW_MS = Math.max(5 * 60 * 1000, parsePositiveInt(process.env.RECENT_ORDER_RECONCILE_WINDOW_MIN, 10) * 60 * 1000);
let lastIdleHeartbeatAt = 0;
let lastWsDomainWarningAt = 0;
let wsDomainUnavailable = false;
const IDLE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

function logIdleHeartbeat(message: string): void {
  const now = Date.now();
  if (now - lastIdleHeartbeatAt < IDLE_HEARTBEAT_INTERVAL_MS) return;
  lastIdleHeartbeatAt = now;
  logger.info(`[轮询] 心跳 ${formatBeijingTime(undefined, 'time')} — ${message}`);
}

const wsOrderQueue: WithdrawOrder[] = [];
const wsQueueSet = new Set<string>();
const wsEvaluatingSet = new Set<string>();
const WS_QUEUE_MAX = 100;
const wsLastStatus = new Map<string, number>();
const WS_LAST_STATUS_MAX = 500;
const PREFETCH_MAX = 200;
const prefetchedDetails = new LRUCache<string, Promise<UserDetailsResponse | null>>({ max: PREFETCH_MAX, ttl: 60 * 1000 });
const prefetchedAdded = new LRUCache<string, number>({ max: PREFETCH_MAX, ttl: 60 * 1000 });
let wsActiveCount = 0;

function getWsConcurrency(): number {
  return parsePositiveInt(process.env.WS_CONCURRENCY, 3);
}

async function processWsOrderQueue(): Promise<void> {
  const wsConcurrency = getWsConcurrency();
  while (wsOrderQueue.length > 0 && wsActiveCount < wsConcurrency) {
    const order = wsOrderQueue.shift()!;
    wsQueueSet.delete(String(order.orderNo || ''));
    wsActiveCount++;
    processSingleWsOrder(order)
      .catch((err) => {
        logger.error({ orderNo: String(order.orderNo || ''), err: (err as Error).message }, '[WS评估] 未捕获异常');
      })
      .finally(() => {
        wsActiveCount--;
        // H1: 仅当队列仍有待处理项且未达到并发上限时才调度下一批
        if (wsOrderQueue.length > 0 && wsActiveCount < getWsConcurrency()) {
          setImmediate(() => processWsOrderQueue());
        }
      });
  }
}

async function processSingleWsOrder(order: WithdrawOrder): Promise<void> {
  const orderNo = String(order.orderNo || '');

  if (evaluatedOrderCache.has(orderNo)) {
    logger.info({ orderNo }, '[WS评估] 订单已评估过，跳过');
    return;
  }

  try {
    const dbEval = await dbHolder.db.riskEval.findUnique({ where: { orderId: orderNo } });
    if (dbEval) {
      trackOpenOrder(order);
      markEvaluated(orderNo);
      consumePrefetchedDetail(orderNo);
      logger.info({ orderNo, riskLevel: dbEval.riskLevel, notified: dbEval.notified }, '[WS评估] 数据库已有评估记录，跳过');
      if (!dbEval.notified) {
        let dbDetail: Record<string, unknown> = {};
        try { dbDetail = JSON.parse(dbEval.detail || '{}'); } catch {}
        const activeRuleIds2 = getActiveRuleIds();
        let rawRules2: TriggeredRule[] = [];
        try { rawRules2 = JSON.parse(dbEval.triggeredRules || '[]'); } catch { rawRules2 = []; }
        const validRules2 = getReplayableRules(rawRules2, activeRuleIds2);
        const result = await handleNotification(order, {
          ...dbEval,
          proxyCode: (dbDetail.proxyCode as string) || extractProxyCode(order) || '',
          orderAmount: (dbDetail.orderAmount as string | number) || order.amount || '',
          balance: (dbDetail.balance as string | number) || '',
          registerTime: (dbDetail.registerTime as string) || '',
          depositCount: (dbDetail.depositCount as number) ?? 0,
          withdrawCount: (dbDetail.withdrawCount as number) ?? 0,
          rechargeWithdrawDiff: (dbDetail.rechargeWithdrawDiff as number) ?? 0,
          rechargeAmount: (dbDetail.rechargeAmount as number) ?? 0,
          withdrawAmount: (dbDetail.withdrawAmount as number) ?? 0,
          profitLoss: dbDetail.profitLoss as number | undefined,
          estimatedProfitLoss: (dbDetail.estimatedProfitLoss as boolean) ?? true,
          triggeredRules: validRules2,
          groupScores: {},
          daysSinceReg: (dbDetail.daysSinceReg as number) ?? 0,
          isEarlyMorning: (dbDetail.isEarlyMorning as boolean) || false,
          mainGameType: (dbDetail.mainGameType as string) || undefined,
          dataIssues: (dbDetail.dataIssues as string[]) || [],
          remark: (dbDetail.remark as string) || '',
        } as EvaluationResult, !!dbEval.notified);
        if (result === 'failed') {
          logger.warn({ orderNo }, '[WS评估] 通知发送失败');
        }
      }
      return;
    }

    logger.info({ orderNo, memberName: order.memberName || order.member_name, amount: order.amount }, '[WS评估] 🚀 WebSocket推送触发实时评估');

    const result = await evaluateOrder(order);

    if (!result) {
      const retries = incrementEvalRetry(orderNo, 'ws');
      if (retries >= MAX_EVAL_RETRY) {
        const fallback = buildFallbackResult(order, orderNo);
        await dbHolder.db.riskEval.upsert({
          where: { orderId: orderNo },
          update: {
            totalScore: fallback.totalScore,
            riskLevel: fallback.riskLevel,
            triggeredRules: JSON.stringify(fallback.triggeredRules),
            detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'ws' }),
          },
          create: {
            orderId: orderNo,
            memberId: String(order.memberId || order.member_id || ''),
            memberName: order.memberName || order.member_name || '',
            totalScore: fallback.totalScore,
            riskLevel: fallback.riskLevel,
            triggeredRules: JSON.stringify(fallback.triggeredRules),
            detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'ws' }),
            notified: false,
          },
        });
        trackOpenOrder(order);
        markEvaluated(orderNo);
        logger.warn({ orderNo, retries }, '[WS评估] 重试耗尽，写入评估失败复核记录');

        const notifyResult = await handleNotification(order, fallback);
        if (notifyResult === 'failed') {
          logger.warn({ orderNo }, '[WS评估] 评估失败复核通知发送失败');
        }
      } else {
        logger.warn({ orderNo, retries }, `[WS评估] 评估失败，${5 * retries}秒后重试 (${retries}/${MAX_EVAL_RETRY})`);
        setTimeout(() => {
          wsOrderQueue.unshift(order);
          wsQueueSet.add(orderNo);
          const mName = order.memberName || order.member_name || '';
          if (mName && !prefetchedDetails.has(orderNo)) {
            const p = apiClient.getUserDetails(mName).catch(() => null);
            prefetchedDetails.set(orderNo, p);
            prefetchedAdded.set(orderNo, Date.now());
          }
          processWsOrderQueue();
        }, 5000 * retries);
      }
      return;
    }

    const memberName = order.memberName || order.member_name || '';
    const memberId = String(order.memberId || order.member_id || '');
    const proxyCode = extractProxyCode(order) || result.proxyCode || '';

    await dbHolder.db.riskEval.upsert({
      where: { orderId: result.orderId || orderNo },
      update: {
        totalScore: result.totalScore,
        riskLevel: result.riskLevel,
        triggeredRules: JSON.stringify(result.triggeredRules),
        detail: buildDetailJson(order, result, { source: 'ws' }),
      },
      create: {
        orderId: result.orderId || orderNo,
        memberId: result.memberId || memberId,
        memberName,
        totalScore: result.totalScore,
        riskLevel: result.riskLevel,
        triggeredRules: JSON.stringify(result.triggeredRules),
        detail: buildDetailJson(order, result, { source: 'ws' }),
        notified: false,
      },
    });
    trackOpenOrder(order);

    await Promise.all([
      updateMemberProfile(memberName, memberId, result, order),
      proxyCode ? updateAgentProfile(proxyCode, memberName, result, order).catch((err) => {
        logger.warn({ proxyCode, err: (err as Error).message }, '[WS评估] 更新代理画像失败');
      }) : Promise.resolve(),
    ]);

    logger.info({ orderNo, level: result.riskLevel, score: result.totalScore, rules: result.triggeredRules.length }, `[WS评估] 订单 ${orderNo}: ${result.riskLevel} (${result.totalScore}分, ${result.triggeredRules.length}条规则)`);

    markEvaluated(orderNo);

    const notifyResult = await handleNotification(order, result);
    if (notifyResult === 'failed') {
      logger.warn({ orderNo }, '[WS评估] 通知发送失败');
    }

  } catch (err) {
    logger.error({ err: (err as Error).message }, '[WS评估] 单订单评估异常');
  } finally {
    wsEvaluatingSet.delete(orderNo);
    prefetchedDetails.delete(orderNo);
    prefetchedAdded.delete(orderNo);
  }
}

function handleWsWithdraw(order: WithdrawOrder, action: 'new' | 'update'): void {
  const orderNo = String(order.orderNo || '');

  if (action === 'new') {
    if (evaluatedOrderCache.has(orderNo) || wsEvaluatingSet.has(orderNo) || wsQueueSet.has(orderNo)) {
      return;
    }
    // 提前告警：队列容量达80%时预警，避免突发流量导致静默丢单
    if (wsOrderQueue.length >= Math.floor(WS_QUEUE_MAX * 0.8)) {
      logger.warn({ queueLen: wsOrderQueue.length, max: WS_QUEUE_MAX }, '[WS] 队列负载过高，可能即将丢弃订单');
    }
    if (wsOrderQueue.length >= WS_QUEUE_MAX) {
      const old = wsOrderQueue.shift()!;
      const oldNo = String(old.orderNo || '');
      wsQueueSet.delete(oldNo);
      wsEvaluatingSet.delete(oldNo);
      prefetchedDetails.delete(oldNo);
      prefetchedAdded.delete(oldNo);
      // 持久化兜底：丢弃的订单写入评估失败记录，避免未知风险被当成低风险
      const oldMemberId = String(old.memberId || old.member_id || '');
      const oldMemberName = old.memberName || old.member_name || '';
      const overflowFallback = buildFallbackResult(old, oldNo, '风控队列溢出，未完成评估，需人工复核');
      dbHolder.db.riskEval.upsert({
        where: { orderId: oldNo },
        update: {},
        create: {
          orderId: oldNo,
          memberId: oldMemberId,
          memberName: oldMemberName,
          totalScore: overflowFallback.totalScore,
          riskLevel: overflowFallback.riskLevel,
          triggeredRules: JSON.stringify(overflowFallback.triggeredRules),
          detail: buildDetailJson(old, overflowFallback, { dropped: true, reason: 'WS队列溢出', queueLen: WS_QUEUE_MAX }),
          notified: false,
        },
      }).catch((dbErr) => {
        // 如果记录已存在则忽略（可能是并发创建）
        if (!(dbErr as Error).message?.includes('UNIQUE constraint')) {
          logger.error({ orderNo: oldNo, err: (dbErr as Error).message }, '[WS] 队列溢出，数据库兜底写入失败');
        }
      });
      logger.warn({ orderNo: oldNo, queueLen: WS_QUEUE_MAX }, '[WS] 队列已满，丢弃最旧订单（已写入评估失败复核记录）');
    }
    logger.info({ orderNo, memberName: order.memberName || order.member_name, amount: order.amount }, '[WS] 📩 新提款订单推送');
    const mName = order.memberName || order.member_name || '';
    if (mName) {
      const p = apiClient.getUserDetails(mName).catch(() => null);
      prefetchedDetails.set(orderNo, p);
      prefetchedAdded.set(orderNo, Date.now());
    }
    wsEvaluatingSet.add(orderNo);
    wsQueueSet.add(orderNo);
    wsOrderQueue.push(order);
    processWsOrderQueue();
  } else {
    const lastStatus = wsLastStatus.get(orderNo);
    if (lastStatus === order.status) return;
    wsLastStatus.set(orderNo, order.status);
    if (wsLastStatus.size > WS_LAST_STATUS_MAX) {
      // 批量删除最旧的条目，防止高并发下 Map 无限增长
      const toDelete = Math.min(100, wsLastStatus.size - Math.floor(WS_LAST_STATUS_MAX * 0.7));
      let deleted = 0;
      for (const key of wsLastStatus.keys()) {
        if (deleted >= toDelete) break;
        wsLastStatus.delete(key);
        deleted++;
      }
    }

    if (FINAL_STATUS_LABELS[order.status]) {
      finalizeTrackedOrder(order)
        .then(() => wsLastStatus.delete(orderNo))
        .catch((err) => {
          logger.warn({ orderNo, status: order.status, err: (err as Error).message }, '[WS] 更新订单最终状态失败');
        });
    }
    if (!evaluatedOrderCache.has(orderNo) && !wsEvaluatingSet.has(orderNo) && !wsQueueSet.has(orderNo) && (order.status === 1 || order.status === 2)) {
      logger.info({ orderNo, status: order.status }, '[WS] 订单未评估，补充入队');
      wsEvaluatingSet.add(orderNo);
      wsQueueSet.add(orderNo);
      const mName = order.memberName || order.member_name || '';
      if (mName && !prefetchedDetails.has(orderNo)) {
        const p = apiClient.getUserDetails(mName).catch(() => null);
        prefetchedDetails.set(orderNo, p);
        prefetchedAdded.set(orderNo, Date.now());
      }
      wsOrderQueue.push(order);
      processWsOrderQueue();
    }
  }
}

function initWebSocket(): void {
  if (!WS_ENABLED) {
    logger.info('[WS] WebSocket 未启用 (WS_ENABLED=false)');
    return;
  }

  const fallbackUrl = WS_URL || '';
  wsClient = new WsClient({
    url: fallbackUrl,
    token: async () => { const t = await auth.getWsToken(); return t?.token || null; },
    onWithdraw: handleWsWithdraw,
    onConnect: () => {
      logger.info('[WS] 连接成功，立即触发轮询补查');
      pollOrders().catch(() => {});
    },
  });

  resolveWsDomainAndConnect();
  logger.info({ envUrl: fallbackUrl || '(未设置)' }, '[WS] WebSocket 客户端已初始化');
}

async function resolveWsDomainAndConnect(): Promise<void> {
  if (!wsClient) return;

  let wsUrl = WS_URL || '';
  let lookupError = '';

  try {
    const apiDomain = await apiClient.getWebSocketDomain();
    if (apiDomain) {
      wsUrl = apiDomain;
    }
  } catch (err) {
    lookupError = (err as Error).message;
  }

  if (!wsUrl) {
    const now = Date.now();
    if (now - lastWsDomainWarningAt >= 5 * 60 * 1000) {
      lastWsDomainWarningAt = now;
      logger.warn({ retryInSec: 60, ...(lookupError ? { err: lookupError } : {}) }, '[WS] 无可用WebSocket域名，将继续重试');
    }
    wsDomainUnavailable = true;
    setTimeout(() => resolveWsDomainAndConnect(), 60 * 1000);
    return;
  }

  if (wsDomainUnavailable) {
    logger.info('[WS] WebSocket域名已恢复，开始连接');
  }
  wsDomainUnavailable = false;
  lastWsDomainWarningAt = 0;

  wsClient.updateUrl(wsUrl);
  wsClient.connect();
}

async function notifyRiskOrders(items: Array<{ order: WithdrawOrder; result: EvaluationResult }>): Promise<void> {
  if (items.length === 0) return;

  const NOTIFY_CONCURRENCY = parsePositiveInt(process.env.NOTIFY_CONCURRENCY, 5);
  const results: PromiseSettledResult<NotifyResult>[] = new Array(items.length);

  // P1: 滑动窗口发送通知，消除批次头线阻塞
  let notifyIdx = 0;
  const workers = Array.from({ length: Math.min(NOTIFY_CONCURRENCY, items.length) }, async () => {
    while (notifyIdx < items.length) {
      const i = notifyIdx++;
      try {
        const r = await handleNotification(items[i].order, items[i].result);
        results[i] = { status: 'fulfilled', value: r };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  });
  await Promise.all(workers);

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value === 'sent') sentCount++;
      else if (r.value === 'skipped') skippedCount++;
      else failedCount++;
    } else {
      failedCount++;
    }
  }

  if (skippedCount > 0) {
    logger.info({ skipped: skippedCount, total: items.length }, '[通知] 批量通知完成，部分订单已被其他路径通知');
  }
  if (failedCount > 0) {
    logger.warn({ failed: failedCount, sent: sentCount, total: items.length }, '[通知] 批量通知部分失败');
  }
}

interface TrackedOpenOrder {
  order: WithdrawOrder;
  firstSeenAt: number;
}

const trackedOpenOrders = new Map<string, TrackedOpenOrder>();
const FINAL_STATUS_LABELS: Record<number, string> = {
  3: 'rejected',
  4: 'success',
  8: 'success',
  9: 'failed',
};
let lastFinalStatusCheck = 0;

function trackOpenOrder(order: WithdrawOrder): void {
  if (order.status !== 1 && order.status !== 2) return;
  const orderNo = String(order.orderNo || order.id || '');
  if (!orderNo) return;
  const existing = trackedOpenOrders.get(orderNo);
  trackedOpenOrders.set(orderNo, {
    order: { ...(existing?.order || {}), ...order },
    firstSeenAt: existing?.firstSeenAt || Date.now(),
  });
}

async function finalizeTrackedOrder(order: WithdrawOrder): Promise<void> {
  const orderNo = String(order.orderNo || order.id || '');
  const finalStatus = FINAL_STATUS_LABELS[Number(order.status)];
  if (!orderNo || !finalStatus) return;

  await dbHolder.db.riskEval.updateMany({
    where: { orderId: orderNo, finalStatus: '' },
    data: { finalStatus },
  });
  if (Number(order.status) === 4 || Number(order.status) === 8) {
    await recordSuccessfulWithdrawal(order);
  }
  trackedOpenOrders.delete(orderNo);
}

/**
 * 只恢复本次重启前一天内、已被评估但尚未拿到最终状态的订单。
 * 这不会补发停机期间已完成订单的提醒，仅补齐成功提款基线和订单终态。
 */
async function restoreTrackedOpenOrders(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const records = await dbHolder.db.riskEval.findMany({
    where: { finalStatus: '', createdAt: { gte: since } },
    select: { orderId: true, memberId: true, memberName: true, detail: true, createdAt: true },
    take: 500,
    orderBy: { createdAt: 'asc' },
  });

  let restored = 0;
  for (const record of records) {
    let detail: Record<string, unknown> = {};
    try { detail = JSON.parse(record.detail || '{}'); } catch { /* 旧记录格式异常时使用安全兜底 */ }
    const orderTime = parseTimeStr(detail.orderTime as string | number | undefined) || record.createdAt.getTime();
    trackOpenOrder({
      orderNo: record.orderId,
      status: 1,
      memberId: record.memberId,
      member_id: record.memberId,
      memberName: record.memberName,
      member_name: record.memberName,
      amount: (detail.orderAmount as string | number | undefined) ?? 0,
      createTime: orderTime,
      proxyCode: detail.proxyCode as string | undefined,
      receivingBank: detail.receivingBank as string | undefined,
      receivingName: detail.receivingName as string | undefined,
      receivingCardNo: detail.receivingCardNo as string | undefined,
      balance: detail.balance as string | number | undefined,
    });
    restored++;
  }

  if (restored > 0) {
    logger.info({ restored }, '[状态] 已恢复重启前未终态订单跟踪，仅补齐终态与成功提款基线');
  }
}

async function reconcileTrackedOrderStatuses(pendingOrders: WithdrawOrder[]): Promise<void> {
  const pendingById = new Map(pendingOrders.map(order => [String(order.orderNo || order.id || ''), order]));
  for (const [orderNo, tracked] of trackedOpenOrders) {
    const pending = pendingById.get(orderNo);
    if (pending) trackedOpenOrders.set(orderNo, { ...tracked, order: { ...tracked.order, ...pending } });
  }

  const missing = [...trackedOpenOrders.entries()].filter(([orderNo]) => !pendingById.has(orderNo));
  if (missing.length === 0 || Date.now() - lastFinalStatusCheck < 60_000) return;
  lastFinalStatusCheck = Date.now();

  const now = Date.now();
  const oldestOrderTime = Math.min(...missing.map(([, tracked]) => parseTimeStr(tracked.order.createTime) || tracked.firstSeenAt));
  const start = Math.max(now - 24 * 60 * 60 * 1000, oldestOrderTime - 5 * 60 * 1000);

  const finalOrders = await apiClient.getAllWithdrawOrdersByStatuses(
    Object.keys(FINAL_STATUS_LABELS).map(Number),
    { start, end: now },
  );
  const finalById = new Map(finalOrders.map(order => [String(order.orderNo || order.id || ''), order]));

  for (const [orderNo, tracked] of missing) {
    const finalOrder = finalById.get(orderNo);
    if (finalOrder) {
      await finalizeTrackedOrder({ ...tracked.order, ...finalOrder });
      continue;
    }
    if (now - tracked.firstSeenAt > 24 * 60 * 60 * 1000) {
      trackedOpenOrders.delete(orderNo);
      logger.warn({ orderNo }, '[状态] 运行期订单超过24小时仍未取得最终状态，停止跟踪');
    }
  }
}

async function pollOrders() {
  if (isPolling) return;
  isPolling = true;

  try {
    const normalOrders = await apiClient.getPendingWithdrawOrders();
    let orders = normalOrders;

    // 每轮轮询均做短窗口全状态对账。WS 是秒级主通道；一旦 WS 或某个
    // 状态页漏推/延迟，对账会在下一轮（当前配置为 30 秒）发现订单。
    try {
      const now = Date.now();
      const recentOrders = await apiClient.getRecentPendingWithdrawOrders({
        start: now - RECENT_ORDER_RECONCILE_WINDOW_MS,
        end: now,
      });
      if (recentOrders.length > 0) {
        const normalOrderNos = new Set(normalOrders.map(order => String(order.orderNo || order.id || '')).filter(Boolean));
        const recovered = recentOrders.filter(order => !normalOrderNos.has(String(order.orderNo || order.id || '')));
        if (recovered.length > 0) {
          logger.warn({ recovered: recovered.length, windowMin: RECENT_ORDER_RECONCILE_WINDOW_MS / 60000 }, '[轮询] 全状态对账发现状态页遗漏订单');
          orders = [...normalOrders, ...recovered];
        }
      }
    } catch (err) {
      // 对账失败不得影响主状态页轮询。
      logger.warn({ err: (err as Error).message }, '[轮询] 全状态对账失败，保留主状态页结果');
    }

    await reconcileTrackedOrderStatuses(orders).catch((err) => {
      logger.warn({ err: (err as Error).message }, '[状态] 运行期订单最终状态查询失败，将稍后重试');
    });

    if (!orders || orders.length === 0) {
      logIdleHeartbeat('无待审核/处理中订单');
      consecutiveFailures = 0;
      return;
    }

    const statusLabel = (s: number) => s === 1 ? '待审核' : s === 2 ? '处理中' : `status=${s}`;
    const statusCount: Record<number, number> = {};
    for (const o of orders) {
      const s = o.status ?? 0;
      statusCount[s] = (statusCount[s] || 0) + 1;
    }
    const statusSummary = Object.entries(statusCount).map(([s, c]) => `${statusLabel(Number(s))}${c}个`).join('，');
    logger.debug({ count: orders.length, summary: statusSummary }, `[轮询] 获取到 ${orders.length} 个订单（${statusSummary}）`);

    const orderNos = orders.map(o => String(o.orderNo || o.id));
    const memHitSet = new Set<string>();
    const memMissList: string[] = [];
    for (const no of orderNos) {
      if (evaluatedOrderCache.has(no)) {
        memHitSet.add(no);
      } else {
        memMissList.push(no);
      }
    }
    if (memMissList.length > 0) {
      const DB_BATCH = 100;
      for (let bi = 0; bi < memMissList.length; bi += DB_BATCH) {
        const batch = memMissList.slice(bi, bi + DB_BATCH);
        const dbEvals = await dbHolder.db.riskEval.findMany({
          where: { orderId: { in: batch } },
          select: { orderId: true },
        });
        for (const e of dbEvals) {
          memHitSet.add(e.orderId);
          evaluatedOrderCache.set(e.orderId, true);
        }
      }
    }
    // WS 已经接管的订单不再由轮询重复评估。通知层虽有幂等保护，
    // 但重复跑完整风控查询会拖慢后续真实新订单。
    const newOrders = orders.filter(o => {
      const orderNo = String(o.orderNo || o.id);
      return !memHitSet.has(orderNo) && !wsEvaluatingSet.has(orderNo) && !wsQueueSet.has(orderNo);
    });

    if (newOrders.length === 0) {
      logIdleHeartbeat(`${orders.length}个订单已全部评估`);
      consecutiveFailures = 0;
      return;
    }

    lastIdleHeartbeatAt = 0;
    logger.info({ newCount: newOrders.length, total: orders.length, summary: statusSummary }, `[轮询] 其中 ${newOrders.length} 个为新订单，开始并发评估`);

    // M1 修复：批量预加载 ruleFeedback（按订单级别），减少 N+1 查询
    try {
      const orderIds = newOrders.map(o => String(o.orderNo || o.id)).filter(Boolean);
      if (orderIds.length > 0) {
        const existingEvals = await dbHolder.db.riskEval.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true, orderId: true },
        });
        if (existingEvals.length > 0) {
          const evalIdToOrderId = new Map(existingEvals.map(e => [e.id, e.orderId]));
          const feedbacks = await dbHolder.db.ruleFeedback.findMany({
            where: { evalId: { in: [...evalIdToOrderId.keys()] }, feedback: { in: ['confirm', 'clear', 'review'] } },
            select: { evalId: true, ruleId: true },
          });
          const mapped = feedbacks.map(f => ({
            key: evalIdToOrderId.get(f.evalId) || f.evalId,
            ruleId: f.ruleId,
          }));
          const { warmHandledRulesCache } = await import('./rule-engine');
          warmHandledRulesCache(mapped);
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[轮询] 批量预加载 ruleFeedback 失败，降级为逐条查询');
    }

    const dynamicConcurrency = newOrders.length > 30 ? 8 : newOrders.length > 15 ? 5 : newOrders.length > 5 ? 4 : 3;
    const CONCURRENCY = Math.min(parsePositiveInt(process.env.POLL_EVAL_MAX_CONCURRENCY, 8), dynamicConcurrency);

    // P2: 批量预取 userDetails，减少 per-evaluation API 调用
    // getUserDetails 需要 memberName，构建 memberId → memberName 映射
    const memberNameMap = new Map<string, string>();
    for (const o of newOrders) {
      const mid = String(o.memberId || o.member_id || '');
      const mname = o.memberName || o.member_name || '';
      if (mid && mname && !memberNameMap.has(mid)) memberNameMap.set(mid, mname);
    }
    const uniqueMemberNames = [...new Set(memberNameMap.values())];
    if (uniqueMemberNames.length > 0) {
      const PREFETCH_BATCH = parsePositiveInt(process.env.PREFETCH_BATCH_SIZE, 10);
      for (let pi = 0; pi < uniqueMemberNames.length; pi += PREFETCH_BATCH) {
        const batch = uniqueMemberNames.slice(pi, pi + PREFETCH_BATCH);
        await Promise.all(batch.map(async (mName) => {
          try {
            const p = apiClient.getUserDetails(mName).catch(() => null);
            // 为每个属于该 memberName 的订单设置预取 promise（key 为 orderNo）
            for (const o of newOrders) {
              const oName = o.memberName || o.member_name || '';
              if (oName === mName) {
                prefetchedDetails.set(String(o.orderNo || o.id), p);
                prefetchedAdded.set(String(o.orderNo || o.id), Date.now());
              }
            }
          } catch { /* 预取失败不阻塞流程 */ }
        }));
      }
      logger.debug({ members: uniqueMemberNames.length }, '[轮询] 批量预取用户详情完成');
    }

    const evalResults = new Map<string, EvaluationResult>();

    // P1: 滑动窗口并发 — 任一订单完成后立即启动下一个，消除固定批次头线阻塞
    let slidingIdx = 0;
    async function processOnePolledOrder(order: WithdrawOrder): Promise<void> {
      try {
        const result = await evaluateOrder(order);
        if (!result) {
          const orderId = String(order.orderNo || order.id);
          const retries = incrementEvalRetry(orderId, 'polling');
          if (retries >= MAX_EVAL_RETRY) {
            try {
              const fallback = buildFallbackResult(order, orderId);
              await dbHolder.db.riskEval.upsert({
                where: { orderId },
                update: {
                  totalScore: fallback.totalScore,
                  riskLevel: fallback.riskLevel,
                  triggeredRules: JSON.stringify(fallback.triggeredRules),
                  detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'polling' }),
                },
                create: {
                  orderId,
                  memberId: String(order.memberId || order.member_id || ''),
                  memberName: order.memberName || order.member_name || '',
                  totalScore: fallback.totalScore,
                  riskLevel: fallback.riskLevel,
                  triggeredRules: JSON.stringify(fallback.triggeredRules),
                  detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'polling' }),
                  notified: false,
                },
              });
              trackOpenOrder(order);
              markEvaluated(orderId);
              logger.warn({ orderNo: order.orderNo || order.id, retries }, '[评估] 重试耗尽，写入评估失败复核记录');

              const notifyResult = await handleNotification(order, fallback);
              if (notifyResult === 'failed') {
                logger.warn({ orderId }, '[评估] 评估失败复核通知发送失败');
              }
            } catch (err) {
              logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, '[评估] 兜底记录写入失败');
            }
          } else {
            logger.warn({ orderNo: order.orderNo || order.id, retries }, `[评估] 评估失败，将在下轮重试 (${retries}/${MAX_EVAL_RETRY})`);
          }
          return;
        }

        const memberName = order.memberName || order.member_name || '';

        evalResults.set(String(order.orderNo || order.id), result);

        try {
          const memberId = String(order.memberId || order.member_id || '');
          const proxyCode = extractProxyCode(order) || result.proxyCode || '';

          await dbHolder.db.riskEval.upsert({
            where: { orderId: result.orderId || String(order.orderNo || order.id) },
            update: {
              totalScore: result.totalScore,
              riskLevel: result.riskLevel,
              triggeredRules: JSON.stringify(result.triggeredRules),
              detail: buildDetailJson(order, result),
            },
            create: {
              orderId: result.orderId || String(order.orderNo || order.id),
              memberId: result.memberId || String(order.memberId || order.member_id),
              memberName,
              totalScore: result.totalScore,
              riskLevel: result.riskLevel,
              triggeredRules: JSON.stringify(result.triggeredRules),
              detail: buildDetailJson(order, result),
              notified: false,
            },
          });

          // DB 持久化成功后才标记为已评估，避免崩溃后订单被永久跳过
          trackOpenOrder(order);
          markEvaluated(String(order.orderNo || order.id));

          await Promise.all([
            updateMemberProfile(memberName, memberId, result, order),
            proxyCode ? updateAgentProfile(proxyCode, memberName, result, order).catch((err) => {
              logger.warn({ proxyCode, err: (err as Error).message }, '[评估] 更新代理画像失败');
            }) : Promise.resolve(),
          ]);

          logger.info({ orderNo: order.orderNo || order.id, level: result.riskLevel, score: result.totalScore, rules: result.triggeredRules.length }, `[评估] 订单 ${order.orderNo || order.id}: ${result.riskLevel} (${result.totalScore}分, ${result.triggeredRules.length}条规则)`);
        } catch (err) {
          // DB 写入失败时不标记 evaluated，下轮轮询会重新评估
          logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, `[评估] 订单 ${order.orderNo || order.id} 保存失败`);
        }
      } catch (err) {
        logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, '[评估] 订单评估未捕获异常');
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, newOrders.length) }, async () => {
      while (slidingIdx < newOrders.length) {
        const order = newOrders[slidingIdx++];
        await processOnePolledOrder(order);
      }
    });
    await Promise.all(workers);

    const notifyOrders: Array<{ order: WithdrawOrder; result: EvaluationResult }> = [];
    for (const order of newOrders) {
      const orderKey = String(order.orderNo || order.id);
      const result = evalResults.get(orderKey);
      if (result) {
        notifyOrders.push({ order, result });
      }
    }

    if (notifyOrders.length > 0) {
      await notifyRiskOrders(notifyOrders);
    }


    consecutiveFailures = 0;
  } catch (err) {
    const errMsg = (err as Error).message || '';
    const isApiError = errMsg.includes('Token') || errMsg.includes('401') || errMsg.includes('API') ||
      errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND') ||
      errMsg.includes('网络') || errMsg.includes('限流') || errMsg.includes('429');
    if (isApiError) {
      consecutiveFailures++;
    }
    logger.error({ consecutiveFailures, max: MAX_CONSECUTIVE_FAILURES, err: errMsg }, `[轮询] 执行失败 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error('[轮询] 连续失败次数过多，auth-service 将自动恢复');
      consecutiveFailures = 0;
    }
  } finally {
    isPolling = false;
    lastPollTime = Date.now();
  }
}

const server = createServer({
  getLastPollTime: () => lastPollTime,
  getPollInterval: () => POLL_INTERVAL,
  isWsEnabled: () => WS_ENABLED,
  getWsUrl: () => WS_URL,
  getWsClient: () => wsClient,
  evaluatedOrderCache,
});

async function main() {
  // 全局未捕获的 Promise 拒绝处理
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, '[全局] 未捕获的 Promise 拒绝');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '[全局] 未捕获异常');
    process.exit(1);
  });

  logger.info('========================================');
  logger.info('  🤖 风控提醒机器人 v5.0');
  logger.info('========================================');

  const envPath = path.resolve(process.cwd(), '.env');
  dotenv.config({ path: envPath });
  logger.level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  reloadConstantsFromEnv();
  logger.info('[Env] 已通过 dotenv 加载 .env 文件');

  POLL_INTERVAL = Math.max(parsePositiveInt(process.env.POLL_INTERVAL, 25) * 1000, 10_000);
  POLL_INTERVAL_WS_CONNECTED = Math.max(parsePositiveInt(process.env.POLL_INTERVAL_WS_CONNECTED, 30) * 1000, 10_000);
  setPrefetchStore(prefetchedDetails);
  const parsedPort = parseInt(process.env.PORT || '0', 10);
  PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 0;
  HOST = process.env.HOST || '127.0.0.1';
  WS_ENABLED = process.env.WS_ENABLED !== 'false';
  WS_URL = (process.env.WS_URL || '').replace(/\/+$/, '');

  const missingEnvs: string[] = [];
  if (!process.env.AUTH_SERVICE_URL) missingEnvs.push('AUTH_SERVICE_URL');
  if (!process.env.AUTH_API_KEY) missingEnvs.push('AUTH_API_KEY');
  if (!process.env.TELEGRAM_BOT_TOKEN) missingEnvs.push('TELEGRAM_BOT_TOKEN');
  if (!process.env.RISK_FINGERPRINT_SECRET) missingEnvs.push('RISK_FINGERPRINT_SECRET');
  // DATABASE_URL 由 ensureDatabase() 自动生成，无需强制配置
  if (missingEnvs.length > 0) {
    logger.fatal({ missing: missingEnvs }, `[配置] 缺少关键环境变量: ${missingEnvs.join(', ')}，无法启动`);
    process.exit(1);
  }

  const tzOffsetVal = parseInt(process.env.TZ_OFFSET || '8', 10);
  if (isNaN(tzOffsetVal) || tzOffsetVal < -12 || tzOffsetVal > 14) {
    logger.warn({ tzOffset: process.env.TZ_OFFSET }, '[配置] TZ_OFFSET 值异常，应为 -12 到 14 之间的整数');
  }

  if (POLL_INTERVAL < 10000) {
    logger.warn({ pollInterval: POLL_INTERVAL / 1000 }, '[配置] POLL_INTERVAL 过小（<10秒），可能导致API限流');
  }

  logger.info({ authServiceUrl: process.env.AUTH_SERVICE_URL, tzOffset: process.env.TZ_OFFSET || '8(默认)', pollInterval: POLL_INTERVAL / 1000, wsEnabled: WS_ENABLED, wsUrl: WS_URL || '(未设置)' }, '[配置] 启动参数');

  await ensureDatabase();
  await restoreTrackedOpenOrders();

  logger.info('[启动] auth-service 已接管 Token 管理');
  const healthy = await apiClient.checkHealth().catch(() => false);
  logger.info(healthy ? '[启动] auth-service 连接正常' : '[启动] auth-service 连接失败，请检查');

  try {
    const ruleConfig = await dbHolder.db.botConfig.findUnique({ where: { key: 'RULE_STATES' } });
    if (ruleConfig?.value) {
      const states = JSON.parse(ruleConfig.value);
      applyRuleStates(states);
      logger.info('[启动] 从数据库加载了规则开关配置');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[启动] 加载规则开关配置失败');
  }

  if (PORT > 0) {
    server.listen(PORT, HOST, () => {
      logger.info({ host: HOST, port: PORT }, `[HTTP] 服务器运行在 http://${HOST}:${PORT}`);
    });
  } else {
    logger.info('[HTTP] 内置 HTTP 服务已禁用（PORT=0）');
  }

  await startTelegramBot();

  initWebSocket();

  const effectivePollInterval = () => {
    if (wsClient && wsClient.connected) {
      return POLL_INTERVAL_WS_CONNECTED;
    }
    return POLL_INTERVAL;
  };

  logger.info({ interval: POLL_INTERVAL / 1000, wsEnabled: WS_ENABLED, wsInterval: POLL_INTERVAL_WS_CONNECTED / 1000 }, `[轮询] 启动定时轮询，WS${WS_ENABLED ? '已启用' : '未启用'}，基础间隔 ${POLL_INTERVAL / 1000}s，WS连接时间隔 ${POLL_INTERVAL_WS_CONNECTED / 1000}s`);

  await sleep(5000);
  await pollOrders();

  let currentInterval = effectivePollInterval();
  let pollTimer: ReturnType<typeof setTimeout>;

  function scheduleNextPoll() {
    pollTimer = setTimeout(async () => {
      await pollOrders();

      if (consecutiveFailures > 0) {
        currentInterval = Math.min(5 * 60 * 1000, Math.min(effectivePollInterval() * 4, currentInterval * 2));
      } else {
        currentInterval = effectivePollInterval();
      }

      scheduleNextPoll();
    }, currentInterval);
  }
  scheduleNextPoll();

  const statusTrackTimer = setInterval(async () => {
    await retryPendingNotifications();
  }, 5 * 60 * 1000);

  const autoReviewTimer = setInterval(async () => {
    await autoReviewExpiredOrders();
  }, 60 * 1000); // 兜底扫描：进程重启后 setTimeout 丢失的补偿

  const watchdogTimer = setInterval(() => {
    const elapsed = Date.now() - lastPollTime;
    const threshold = effectivePollInterval() * 3;
    if (elapsed > threshold && !isPolling) {
      logger.warn({ elapsedSec: Math.round(elapsed / 1000) }, `[看门狗] 超过 ${Math.round(elapsed / 1000)}s 未成功轮询，强制触发`);
      pollOrders().catch(() => {});
    }
  }, 2 * 60 * 1000);

  const wsRecoveryTimer = setInterval(() => {
    if (!WS_ENABLED || !wsClient) return;
    if (!wsClient.connected && wsClient.stopped) {
      logger.info('[WS恢复] WebSocket重连已耗尽，尝试恢复连接');
      wsClient.resetReconnect();
      resolveWsDomainAndConnect();
    }
  }, 5 * 60 * 1000);

  const cleanupTimer = setInterval(async () => {
    try {
      const now = Date.now();

      // 定期输出缓存利用率，用于调优 TTL 和 max 参数
      try {
        const cacheStats = getCacheStats();
        const highUtil = Object.entries(cacheStats).filter(([, s]) => {
          const util = parseFloat(s.utilization);
          return util > 80;
        });
        if (highUtil.length > 0) {
          logger.warn({ stats: cacheStats }, `[缓存] ${highUtil.length}个缓存利用率>80%，考虑增大max或缩短TTL`);
        } else {
          logger.debug({ stats: cacheStats }, '[缓存] 缓存利用率正常');
        }
      } catch {}

      if (prefetchedDetails.size > 200) {
        const staleThreshold = 60 * 1000;
        let cleared = 0;
        for (const [key, addedAt] of prefetchedAdded) {
          if (cleared >= 100) break;
          if (now - addedAt > staleThreshold) {
            prefetchedDetails.delete(key);
            prefetchedAdded.delete(key);
            cleared++;
          }
        }
      }

      const retryStaleThreshold = 10 * 60 * 1000;
      let retryCleared = 0;
      for (const [key, entry] of evalRetryCount) {
        if (now - entry.ts > retryStaleThreshold) {
          evalRetryCount.delete(key);
          retryCleared++;
        }
      }
      if (retryCleared > 0) {
        logger.info({ cleared: retryCleared }, `[清理] 删除 ${retryCleared} 条过期的重试计数`);
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
      const halfYearAgo = new Date(Date.now() - 180 * 86400000);

      const lowDeleted = await dbHolder.db.riskEval.deleteMany({
        where: { riskLevel: 'LOW', createdAt: { lt: thirtyDaysAgo }, notified: true },
      });

      const oldDeleted = await dbHolder.db.riskEval.deleteMany({
        where: { riskLevel: { in: ['MEDIUM'] }, createdAt: { lt: ninetyDaysAgo }, notified: true },
      });

      const highDeleted = await dbHolder.db.riskEval.deleteMany({
        where: { riskLevel: { in: ['HIGH', 'CRITICAL'] }, createdAt: { lt: halfYearAgo }, notified: true },
      });

      const staleUnnotified = await dbHolder.db.riskEval.deleteMany({
        where: { notified: false, createdAt: { lt: new Date(Date.now() - 180 * 86400000) } },
      });

      // 清理90天前的审核反馈记录，防止 RuleFeedback 无限增长
      const feedbackInfoDeleted = await dbHolder.db.ruleFeedback.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 90 * 86400000) } },
      });

      const successfulWithdrawDeleted = await dbHolder.db.successfulWithdrawal.deleteMany({
        where: { createTime: { lt: new Date(Date.now() - 365 * 86400000) } },
      });

      if (lowDeleted.count > 0 || oldDeleted.count > 0 || highDeleted.count > 0 || staleUnnotified.count > 0 || feedbackInfoDeleted.count > 0 || successfulWithdrawDeleted.count > 0) {
        logger.info({ lowDeleted: lowDeleted.count, oldDeleted: oldDeleted.count, highDeleted: highDeleted.count, staleUnnotified: staleUnnotified.count, feedbackDeleted: feedbackInfoDeleted.count, successfulWithdrawDeleted: successfulWithdrawDeleted.count }, `[清理] 删除 ${lowDeleted.count}条LOW(30d) ${oldDeleted.count}条MEDIUM(90d) ${highDeleted.count}条HIGH/CRITICAL(180d) ${staleUnnotified.count}条超期未通知(180d) ${feedbackInfoDeleted.count}条审核反馈(90d) ${successfulWithdrawDeleted.count}条成功提款基线(365d)`);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[清理] 数据自动清理失败');
    }
  }, 6 * 60 * 60 * 1000);

  // 启动后从数据库加载动态配置（白名单等）
  await reloadConstantsFromDB().catch(err => logger.warn({ err: (err as Error).message }, '[启动] 加载动态配置失败'));

  logger.info('[启动] 🎉 风控机器人已完全启动');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, `[关闭] 收到 ${signal}，正在优雅关闭...`);
    clearTimeout(pollTimer);
    clearInterval(statusTrackTimer);
    clearInterval(autoReviewTimer);
    clearInterval(watchdogTimer);
    clearInterval(wsRecoveryTimer);
    clearInterval(cleanupTimer);
    if (wsClient) {
      wsClient.disconnect();
      wsClient = null;
    }
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try { await dbHolder.db.$disconnect(); } catch {}
    logger.info('[关闭] 风控机器人已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, '[启动] 致命错误');
  process.exit(1);
});
