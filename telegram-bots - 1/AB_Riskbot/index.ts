import { createServer } from './server';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { LRUCache } from 'lru-cache';
import { apiClient } from './api-client';
import { evaluateOrder, recordEvaluationProfile, getCacheStats, recordSuccessfulWithdrawal } from './evaluator';
import { extractProxyCode, formatBeijingTime, getTzOffsetMs, getTzOffsetMinutes, parseTimeStr } from './utils';
import { startTelegramBot, sendRiskAlert, autoReviewExpiredOrders } from './telegram';
import { dbHolder, ensureDatabase } from './db';
import { getActiveRuleIds, applyRuleStates } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import { logger } from './logger';
import type { WithdrawOrder } from './types';
import { reloadConstantsFromDB, reloadConstantsFromEnv } from './constants';
import type { TriggeredRule } from './types';
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildDetailJson(order: WithdrawOrder, result?: EvaluationResult | null, extra?: Record<string, any>): string {
  const proxyCode = extractProxyCode(order) || result?.proxyCode || '';
  const receivingName = order?.receivingName || '';
  const detail: Record<string, any> = {
    orderAmount: order.amount,
    orderCurrency: order.currency || 'CNY',
    orderTime: (order.createTime ?? order.createdAt),
    proxyCode,
    receivingBank: order.receivingBank,
    receivingName,
    vipLevel: result?.vipLevel ?? order.vipLevel,
    balance: String(result?.balance ?? order.balance ?? ''),
    registerTime: result?.registerTime || '',
    depositCount: result?.depositCount ?? 0,
    withdrawCount: result?.withdrawCount ?? 0,
    rechargeWithdrawDiff: result?.rechargeWithdrawDiff ?? 0,
    totalRecharge: result?.totalRecharge ?? 0,
    totalWithdraw: result?.totalWithdraw ?? 0,
    sumBet: result?.sumBet ?? 0,
    daysSinceReg: result?.daysSinceReg,
    isEarlyMorning: result?.isEarlyMorning || false,
    topGameTypes: result?.topGameTypes || '',
    remark: result?.remark || String(order.memberRemark || ''),
    groupScores: result?.groupScores || {},
  };
  if (result?.triggeredRules) {
    // 优先使用 lhc-checker 生成的完整 periodInfo
    if (result.periodInfo) {
      detail.periodInfo = result.periodInfo;
    } else {
      const bettingRules = result.triggeredRules.filter((r: TriggeredRule) => ['R24', 'R25', 'R26'].includes(r.id));
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
    }],
    groupScores: { environment: 30 },
    depositCount: 0,
    withdrawCount: 0,
    registerTime: '',
    daysSinceReg: undefined,
    rechargeWithdrawDiff: 0,
    totalRecharge: 0,
    totalWithdraw: 0,
    proxyCode: extractProxyCode(order),
    orderAmount: String(order.amount ?? ''),
    balance: String(order.balance ?? ''),
    remark: String(order.memberRemark || ''),
    isEarlyMorning: false,
  };
}

function getReplayableRules(
  rawRules: { id: string; name: string; reason: string; score: number; severity?: string; group?: string }[],
  activeRuleIds: Set<string>,
): { id: string; name: string; reason: string; score: number; severity?: string; group?: string }[] {
  return rawRules.filter((r) => activeRuleIds.has(r.id) || SYNTHETIC_RULE_IDS.has(r.id));
}

/** upsert 写入评估结果。notifyMsgId / notifiedAt 在通知发送后才写入，此处无需保留。 */
async function upsertRiskEval(
  orderId: string,
  data: {
    totalScore: number;
    riskLevel: string;
    triggeredRules: string;
    detail: string;
    memberId?: string;
    memberName?: string;
  },
): Promise<void> {
  await dbHolder.db.riskEval.upsert({
    where: { orderId },
    update: {
      totalScore: data.totalScore,
      riskLevel: data.riskLevel,
      triggeredRules: data.triggeredRules,
      detail: data.detail,
    },
    create: {
      orderId,
      memberId: data.memberId || '',
      memberName: data.memberName || '',
      totalScore: data.totalScore,
      riskLevel: data.riskLevel,
      triggeredRules: data.triggeredRules,
      detail: data.detail,
      notified: false,
    },
  });
}

/** 防止部署时误换 HMAC 密钥，使旧收款指纹产生错误关联或错误变更提示。 */
async function ensureFingerprintSecretConsistency(): Promise<void> {
  const secret = (process.env.RISK_FINGERPRINT_SECRET || '').trim();
  const keyId = crypto.createHash('sha256').update(`AB_Riskbot:fingerprint-key:${secret}`).digest('hex');
  const configKey = 'RISK_FINGERPRINT_KEY_ID';
  const existing = await dbHolder.db.botConfig.findUnique({ where: { key: configKey } });

  if (existing?.value && existing.value !== keyId) {
    throw new Error('RISK_FINGERPRINT_SECRET 已变更。请恢复原密钥；更换密钥会破坏既有收款指纹比较。');
  }
  if (existing?.value === keyId) return;

  await dbHolder.db.botConfig.upsert({
    where: { key: configKey },
    update: { value: keyId },
    create: { key: configKey, value: keyId },
  });
  logger.info('[配置] 收款指纹密钥标识已初始化；后续不得修改 RISK_FINGERPRINT_SECRET');
}

let POLL_INTERVAL = 60 * 1000;
let PORT = 0;

const evaluatedOrderCache = new LRUCache<string, boolean>({ max: 2000, ttl: 2 * 60 * 60 * 1000 });
const evalRetryCount = new LRUCache<string, { count: number; source: string; ts: number }>({
  max: 2000,
  ttl: 10 * 60 * 1000,
});
const MAX_EVAL_RETRY = 3;

function getEvalRetry(orderNo: string, source: string): number {
  const entry = evalRetryCount.get(`${orderNo}:${source}`);
  return entry?.count || 0;
}

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
  for (const source of ['poll', 'polling', 'recovery', 'recovery-retry']) {
    evalRetryCount.delete(`${orderNo}:${source}`);
  }
}

type NotifyResult = 'sent' | 'skipped' | 'failed';

const noOrderNoNotifySet = new Set<string>();

// 防止同一订单并发通知：将 orderNo 串行化，CAS 之外的额外保护层
const notifyingLocks = new Map<string, Promise<NotifyResult>>();

// 通知节流缓存：同一订单 5 分钟内不重复通知（模块作用域，跨调用共享）
const recentNotifications = new LRUCache<string, number>({ max: 500, ttl: 5 * 60 * 1000 });

function wasRecentlyNotified(orderNo: string): boolean {
  return recentNotifications.has(orderNo);
}

function markRecentlyNotified(orderNo: string): void {
  recentNotifications.set(orderNo, Date.now());
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

  let dbReadFailed = false; // DB 读取失败（需走乐观路径）

  const doNotify = async (): Promise<NotifyResult> => {
    // 5分钟内已通知过 → 直接跳过（内存缓存，所有路径生效）
    if (wasRecentlyNotified(orderNo)) {
      return 'skipped';
    }

    if (precheckedNotified === false) {
    } else {
      try {
        const existing = await dbHolder.db.riskEval.findUnique({
          where: { orderId: orderNo },
          select: { notified: true },
        });
        if (existing?.notified) {
          markRecentlyNotified(orderNo);
          return 'skipped';
        }
      } catch (err) {
        // DB 读取失败时不跳过，走乐观路径：先发通知，再尽力补标记
        dbReadFailed = true;
        logger.warn({ orderNo, err: (err as Error).message }, '[通知] DB查询失败，走乐观路径：先发送通知，再尽力补标记');
      }
    }

    // 先发送通知，成功后再 CAS 标记 notified=true（避免孤儿订单）
    const { success: notified, messageId } = await sendRiskAlert(result, order);
    if (!notified) return 'failed';

    markRecentlyNotified(orderNo);

    // 通知发送成功后，以一次 CAS 同时保存通知状态、时间和消息 ID。
    // 不能先单独标记 notified，否则第二次写入失败会导致自动审核永远没有 notifiedAt。
    try {
      const r = await dbHolder.db.riskEval.updateMany({
        where: { orderId: orderNo, notified: false },
        data: {
          notified: true,
          notifiedAt: new Date(),
          ...(messageId ? { notifyMsgId: messageId } : {}),
        },
      });
      if (r.count === 0) {
        logger.warn(
          { orderNo, dbReadFailed },
          '[通知] 消息已发送但 CAS 未写入记录；该告警可能无法自动审核，请检查数据库状态',
        );
      }
    } catch (err) {
      logger.warn({ orderNo, err: (err as Error).message }, '[通知] 通知状态 CAS 写入失败，但消息已发送');
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

let isRetryingUnsentNotifications = false;

async function retryUnsentNotifications(): Promise<void> {
  if (isRetryingUnsentNotifications) return;
  isRetryingUnsentNotifications = true;
  try {
    const BATCH_SIZE = 50;
    const MAX_PER_RUN = 500;
    let totalProcessed = 0;
    // createdAt 只有秒级精度时，多笔订单可能完全相同；连同主键作为游标，
    // 避免某一笔持续发送失败而卡住同一秒内其后的待通知订单。
    let lastCursor: { createdAt: Date; id: string } | undefined;

    // 顺序处理最旧的未通知订单（asc），基于游标分页避免 offset 偏移
    while (true) {
      const whereClause: any = { notified: false, finalStatus: '' };
      if (lastCursor) {
        whereClause.OR = [
          { createdAt: { gt: lastCursor.createdAt } },
          { createdAt: lastCursor.createdAt, id: { gt: lastCursor.id } },
        ];
      }
      const unnotifiedEvals = await dbHolder.db.riskEval.findMany({
        where: whereClause,
        take: BATCH_SIZE,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      if (unnotifiedEvals.length === 0) break;

      logger.info({ count: unnotifiedEvals.length, offset: totalProcessed }, '[追踪] 发现未通知的风险订单，尝试补发');

      const activeRuleIds = getActiveRuleIds();
      const results = await Promise.allSettled(
        unnotifiedEvals.map(async (evalRecord) => {
          let detail: Record<string, unknown> = {};
          try { detail = JSON.parse(evalRecord.detail || '{}'); } catch {}
          let rawRules: { id: string; name: string; reason: string; score: number; severity?: string; group?: string }[] = [];
          try { rawRules = JSON.parse(evalRecord.triggeredRules || '[]'); } catch { rawRules = []; }
          const validRules = getReplayableRules(rawRules, activeRuleIds);
          return handleNotification(
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
              balance: (detail.balance as string | number) ?? '',
              createTime: (detail.orderTime as string | number) || '',
              vipLevel: (detail.vipLevel as string | number) || '',
            } as WithdrawOrder,
            {
              ...evalRecord,
              proxyCode: (detail.proxyCode as string) || '',
              orderAmount: (detail.orderAmount as string | number) || '',
              balance: (detail.balance as string | number) ?? '',
              registerTime: (detail.registerTime as string) || '',
              depositCount: (detail.depositCount as number) ?? 0,
              withdrawCount: (detail.withdrawCount as number) ?? 0,
              rechargeWithdrawDiff: (detail.rechargeWithdrawDiff as number) ?? 0,
              totalRecharge: (detail.totalRecharge as number) ?? 0,
              totalWithdraw: (detail.totalWithdraw as number) ?? 0,
              vipLevel: detail.vipLevel as number | string | undefined,
              sumBet: (detail.sumBet as number) ?? 0,
              triggeredRules: validRules,
              groupScores: {},
              daysSinceReg: (detail.daysSinceReg as number) ?? 0,
              isEarlyMorning: (detail.isEarlyMorning as boolean) || false,
              remark: (detail.remark as string) || '',
            } as EvaluationResult,
            false
          );
        })
      );

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
        logger.info({ sent, skipped, failed, batch: unnotifiedEvals.length }, '[追踪] 补发通知完成');
      }

      totalProcessed += unnotifiedEvals.length;
      if (totalProcessed >= MAX_PER_RUN) break;
      // 使用 createdAt + id 复合游标，避免相同时间戳的记录被跳过或饿死。
      const lastEval = unnotifiedEvals[unnotifiedEvals.length - 1];
      if (lastEval?.createdAt) lastCursor = { createdAt: lastEval.createdAt, id: lastEval.id };
      // 批次间释放事件循环，避免长时间阻塞其他异步任务
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[追踪] 补发通知检查失败');
  } finally {
    isRetryingUnsentNotifications = false;
  }
}

let isPolling = false;
let lastPollTime = 0;
let consecutiveFailures = 0;
let lastIdleHeartbeatAt = 0;
const IDLE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;

function logIdleHeartbeat(message: string): void {
  const now = Date.now();
  if (now - lastIdleHeartbeatAt < IDLE_HEARTBEAT_INTERVAL_MS) return;
  lastIdleHeartbeatAt = now;
  logger.info(`[轮询] 心跳 ${formatBeijingTime(undefined, 'time')} — ${message}`);
}

async function notifyRiskOrders(items: Array<{ order: WithdrawOrder; result: EvaluationResult }>): Promise<void> {
  if (items.length === 0) return;

  const NOTIFY_CONCURRENCY = 5;
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

const PENDING_RECOVERY_MINUTES = 60;
let lastRecoveryTime = 0;

async function recoverPendingOrders(): Promise<void> {
  const now = Date.now();
  if (now - lastRecoveryTime < 5 * 60 * 1000) return;
  lastRecoveryTime = now;

  try {
    const offset = getTzOffsetMs();
    const localNow = new Date(now + offset);
    const since = new Date(localNow);
    since.setMinutes(since.getMinutes() - PENDING_RECOVERY_MINUTES);
    since.setSeconds(0, 0);
    const dateRange = {
      start: since.getTime() - offset,
      end: localNow.getTime() - offset,
    };

    const pendingOrders = await apiClient.getAllWithdrawOrdersByStatuses([1, 2], dateRange);
    if (!pendingOrders || pendingOrders.length === 0) return;

    const unevaluated: string[] = [];
    for (const o of pendingOrders) {
      const no = String(o.orderNo || o.id);
      if (evaluatedOrderCache.has(no)) continue;
      unevaluated.push(no);
    }

    if (unevaluated.length === 0) return;

    const DB_BATCH = 100;
    const dbSet = new Set<string>();
    const retryCandidateSet = new Set<string>();
    for (let bi = 0; bi < unevaluated.length; bi += DB_BATCH) {
      const batch = unevaluated.slice(bi, bi + DB_BATCH);
      const dbEvals = await dbHolder.db.riskEval.findMany({
        where: { orderId: { in: batch } },
        select: { orderId: true, detail: true },
      });
      for (const e of dbEvals) {
        dbSet.add(e.orderId);
        try {
          const d = JSON.parse(e.detail || '{}');
          if (d.evalFailed) retryCandidateSet.add(e.orderId);
        } catch {
          // JSON 解析失败视为数据损坏，加入重试候选以重新评估
          logger.warn({ orderId: e.orderId }, '[补查] detail JSON 解析失败，作为重试候选处理');
          retryCandidateSet.add(e.orderId);
        }
      }
    }
    const missedSet = new Set(unevaluated.filter(no => !dbSet.has(no)));

    for (const no of dbSet) {
      if (!retryCandidateSet.has(no)) {
        markEvaluated(no);
      }
    }

    const RECOVERY_CONCURRENCY = 4;

    async function processMissedOrder(order: WithdrawOrder): Promise<void> {
      const orderNo = String(order.orderNo || order.id);
      try {
        const result = await evaluateOrder(order);
        if (result) {
          const memberName = order.memberName || order.member_name || '';
          const memberId = String(order.memberId || order.member_id || '');

          await upsertRiskEval(result.orderId || orderNo, {
            totalScore: result.totalScore,
            riskLevel: result.riskLevel,
            triggeredRules: JSON.stringify(result.triggeredRules),
            detail: buildDetailJson(order, result, { source: 'recovery' }),
            memberId: result.memberId || memberId,
            memberName,
          });
          await recordEvaluationProfile(order, result);

          const notifyResult = await handleNotification(order, result);
          if (notifyResult === 'failed') {
            logger.warn({ orderNo }, '[补查] 通知发送失败');
          }
          // 无论是否有违规规则，DB 持久化成功后都应标记为已评估，防止重复评估浪费资源
          markEvaluated(orderNo);
        } else {
          const retries = incrementEvalRetry(orderNo, 'recovery');
          if (retries >= MAX_EVAL_RETRY) {
            try {
              const fallback = buildFallbackResult(order, orderNo);
              await upsertRiskEval(orderNo, {
                totalScore: fallback.totalScore,
                riskLevel: fallback.riskLevel,
                triggeredRules: JSON.stringify(fallback.triggeredRules),
                detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'recovery' }),
                memberId: fallback.memberId,
                memberName: fallback.memberName,
              });
              const notifyResult = await handleNotification(order, fallback);
              if (notifyResult === 'failed') {
                logger.warn({ orderNo }, '[补查] 评估失败复核通知发送失败');
              }
              markEvaluated(orderNo);
              logger.warn({ orderNo, retries }, '[补查] 遗漏订单重试耗尽，写入评估失败复核记录');
            } catch (e) {
              logger.error({ orderNo, err: (e as Error).message }, '[补查] 兜底记录写入失败');
            }
          } else {
            logger.warn({ orderNo, retries }, `[补查] 评估失败，将在下轮重试 (${retries}/${MAX_EVAL_RETRY})`);
          }
        }
      } catch (err) {
        logger.error({ orderNo, err: (err as Error).message }, '[补查] 评估遗漏订单失败');
      }
    }

    async function processRetryOrder(order: WithdrawOrder): Promise<void> {
      const orderNo = String(order.orderNo || order.id);
      try {
        const result = await evaluateOrder(order);
        if (result) {
          await dbHolder.db.riskEval.update({
            where: { orderId: orderNo },
            data: {
              totalScore: result.totalScore,
              riskLevel: result.riskLevel,
              triggeredRules: JSON.stringify(result.triggeredRules),
              detail: buildDetailJson(order, result, { source: 'recovery-retry' }),
            },
          });
          await recordEvaluationProfile(order, result);
          const notifyResult = await handleNotification(order, result);
          if (notifyResult === 'failed') {
            logger.warn({ orderNo }, '[补查] 通知发送失败');
          }
          // 无论是否有违规规则，DB 持久化成功后都应标记为已评估
          markEvaluated(orderNo);
        } else {
          const retries = incrementEvalRetry(orderNo, 'recovery-retry');
          if (retries >= MAX_EVAL_RETRY) {
            try {
              const fallback = buildFallbackResult(order, orderNo);
              await dbHolder.db.riskEval.update({
                where: { orderId: orderNo },
                data: {
                  totalScore: fallback.totalScore,
                  riskLevel: fallback.riskLevel,
                  triggeredRules: JSON.stringify(fallback.triggeredRules),
                  detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'recovery-retry' }),
                },
              });
              const notifyResult = await handleNotification(order, fallback);
              if (notifyResult === 'failed') {
                logger.warn({ orderNo }, '[补查] 评估失败复核通知发送失败');
              }
              markEvaluated(orderNo);
              logger.warn({ orderNo, retries }, '[补查] 重试订单重试耗尽，写入评估失败复核记录');
            } catch (e) {
              logger.error({ orderNo, err: (e as Error).message }, '[补查] 评估失败复核记录写入失败');
            }
          } else {
            logger.debug({ orderNo, retries }, '[补查] 重新评估失败订单仍失败，保留重试机会');
          }
        }
      } catch (err) {
        logger.debug({ orderNo, err: (err as Error).message }, '[补查] 重新评估失败订单异常');
      }
    }

    if (missedSet.size > 0) {
      const missedArr = [...missedSet];
      logger.warn({ count: missedArr.length, sample: missedArr.slice(0, 5) }, `[补查] 发现 ${missedArr.length} 笔待处理但未评估的订单`);
      const missedOrders = pendingOrders.filter(o => missedSet.has(String(o.orderNo || o.id)));
      // P1: 滑动窗口替代固定批次
      let missedIdx = 0;
      const missedWorkers = Array.from({ length: Math.min(RECOVERY_CONCURRENCY, missedOrders.length) }, async () => {
        while (missedIdx < missedOrders.length) {
          await processMissedOrder(missedOrders[missedIdx++]);
        }
      });
      await Promise.all(missedWorkers);
    }

    if (retryCandidateSet.size > 0) {
      logger.info({ count: retryCandidateSet.size }, `[补查] 重新评估 ${retryCandidateSet.size} 笔之前失败的订单`);
      const retryOrders = pendingOrders.filter(o => retryCandidateSet.has(String(o.orderNo || o.id)));
      // P1: 滑动窗口替代固定批次
      let retryIdx = 0;
      const retryWorkers = Array.from({ length: Math.min(RECOVERY_CONCURRENCY, retryOrders.length) }, async () => {
        while (retryIdx < retryOrders.length) {
          await processRetryOrder(retryOrders[retryIdx++]);
        }
      });
      await Promise.all(retryWorkers);
    }
  } catch (err) {
    // 补查失败时重置节流时间，允许更快重试
    lastRecoveryTime = 0;
    logger.debug({ err: (err as Error).message }, '[补查] 待处理订单补查失败');
  }
}

interface TrackedOpenOrder {
  order: WithdrawOrder;
  firstSeenAt: number;
}

// 平台 A：0处理中、1未受理、2已受理、3已出款、4已取消、5已拒绝。
// 仅运行期见过的 1/2 状态订单会被跟踪，重启不会扫描历史已完成订单。
const trackedOpenOrders = new Map<string, TrackedOpenOrder>();
const FINAL_STATUS_LABELS: Record<number, string> = {
  3: 'success',
  4: 'cancelled',
  5: 'rejected',
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
  if (Number(order.status) === 3) {
    const recorded = await recordSuccessfulWithdrawal(order);
    if (!recorded) {
      logger.warn({ orderNo }, '[状态] 成功提款历史写入失败，保留订单跟踪并在下轮重试');
      return;
    }
  }
  trackedOpenOrders.delete(orderNo);
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
  const finalOrders = await apiClient.getAllWithdrawOrdersByStatuses([3, 4, 5], { start, end: now });
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
    const orders: WithdrawOrder[] = await apiClient.getPendingWithdrawOrders();
    // 仅在成功取得待处理订单后更新健康时间；失败轮询不能伪装成成功。
    lastPollTime = Date.now();
    await reconcileTrackedOrderStatuses(orders).catch((err) => {
      logger.warn({ err: (err as Error).message }, '[状态] 运行期订单最终状态查询失败，将稍后重试');
    });
    for (const order of orders) trackOpenOrder(order);

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
    // DB 去重已移除。pending 订单每次启动/轮询均应重新评估，
    // 因为投注数据、会员行为可能已变化。同会话内的去重由内存缓存处理。
    const newOrders = orders.filter(o => !memHitSet.has(String(o.orderNo || o.id)));

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
            where: { evalId: { in: [...evalIdToOrderId.keys()] }, feedback: 'review' },
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

    // 单笔评估会并行请求多个上游接口；限制外层并发，避免把 auth-service 队列堆满并触发 30 秒超时。
    const configuredConcurrency = Math.min(Math.max(parseInt(process.env.EVALUATION_CONCURRENCY || '3', 10) || 3, 1), 6);
    const CONCURRENCY = Math.min(configuredConcurrency, newOrders.length);

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
              const memberName = order.memberName || order.member_name || '';
              await upsertRiskEval(orderId, {
                totalScore: fallback.totalScore,
                riskLevel: fallback.riskLevel,
                triggeredRules: JSON.stringify(fallback.triggeredRules),
                detail: buildDetailJson(order, fallback, { evalFailed: true, retries, source: 'polling' }),
                memberId: fallback.memberId,
                memberName: fallback.memberName || memberName,
              });
              const notifyResult = await handleNotification(order, fallback);
              if (notifyResult === 'failed') {
                logger.warn({ orderId }, '[评估] 评估失败复核通知发送失败');
              }
              markEvaluated(orderId);
              logger.warn({ orderNo: order.orderNo || order.id, retries }, '[评估] 重试耗尽，写入评估失败复核记录');
            } catch (err) {
              logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, '[评估] 兜底记录写入失败');
            }
          } else {
            logger.warn({ orderNo: order.orderNo || order.id, retries }, `[评估] 评估失败，将在下轮重试 (${retries}/${MAX_EVAL_RETRY})`);
          }
          return;
        }

        const memberName = order.memberName || order.member_name || '';

        try {
          await upsertRiskEval(result.orderId || String(order.orderNo || order.id), {
            totalScore: result.totalScore,
            riskLevel: result.riskLevel,
            triggeredRules: JSON.stringify(result.triggeredRules),
            detail: buildDetailJson(order, result),
            memberId: result.memberId || String(order.memberId || order.member_id),
            memberName,
          });

          await recordEvaluationProfile(order, result);

          // 风险结果和画像贡献均已持久化后才标记，失败时下轮可以安全重试。
          markEvaluated(String(order.orderNo || order.id));

          // 仅让已持久化的评估进入通知队列，避免数据库故障时发出
          // 无法自动审核、也无法可靠去重的孤立 Telegram 告警。
          evalResults.set(String(order.orderNo || order.id), result);

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


    recoverPendingOrders().catch(err => logger.error({ err: (err as Error).message }, '[补查] 异步补查异常'));

    consecutiveFailures = 0;
  } catch (err) {
    const errMsg = (err as Error).message || '';
    consecutiveFailures++;
    logger.error({ consecutiveFailures, max: MAX_CONSECUTIVE_FAILURES, err: errMsg }, `[轮询] 执行失败 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error('[轮询] 连续失败次数过多，保持退避并等待 auth-service 恢复');
    }
  } finally {
    isPolling = false;
  }
}

const server = createServer({
  getLastPollTime: () => lastPollTime,
  getPollInterval: () => POLL_INTERVAL,
  evaluatedOrderCache,
});

async function main() {
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

  const configuredPollInterval = parseInt(process.env.POLL_INTERVAL || '15', 10);
  POLL_INTERVAL = Number.isFinite(configuredPollInterval)
    ? Math.max(configuredPollInterval * 1000, 10_000)
    : 15_000;
  const configuredPort = parseInt(process.env.PORT || '0', 10);
  PORT = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
    ? configuredPort
    : 0;

  const missingEnvs: string[] = [];
  // AUTH_SERVICE_URL 和 TELEGRAM_BOT_TOKEN 为必需；AUTH_API_KEY 为必需（连接 auth-service）；
  // DATABASE_URL 由 ensureDatabase() 自动生成（SQLite 文件路径），无需强制配置
  if (!process.env.AUTH_SERVICE_URL) missingEnvs.push('AUTH_SERVICE_URL');
  if (!process.env.AUTH_API_KEY) missingEnvs.push('AUTH_API_KEY');
  if (!process.env.TELEGRAM_BOT_TOKEN) missingEnvs.push('TELEGRAM_BOT_TOKEN');
  if ((process.env.RISK_FINGERPRINT_SECRET || '').trim().length < 32) {
    missingEnvs.push('RISK_FINGERPRINT_SECRET（至少32字符）');
  }
  if (missingEnvs.length > 0) {
    logger.fatal({ missing: missingEnvs }, `[配置] 缺少关键环境变量: ${missingEnvs.join(', ')}，无法启动`);
    process.exit(1);
  }

  // 触发 TZ_OFFSET 的解析和缓存（内部自动验证范围）
  const tzOffsetHours = getTzOffsetMinutes() / 60;
  if (process.env.TZ_OFFSET && (isNaN(parseInt(process.env.TZ_OFFSET, 10)) || parseInt(process.env.TZ_OFFSET, 10) < -12 || parseInt(process.env.TZ_OFFSET, 10) > 14)) {
    logger.warn({ tzOffset: process.env.TZ_OFFSET }, '[配置] TZ_OFFSET 值异常，应为 -12 到 14 之间的整数，已回退为 UTC+8');
  }

  const rawPollIntervalSec = parseInt(process.env.POLL_INTERVAL || '15', 10);
  if (rawPollIntervalSec < 10 && rawPollIntervalSec > 0) {
    logger.warn({ pollInterval: rawPollIntervalSec }, '[配置] POLL_INTERVAL 过小（<10秒），可能导致API限流');
  }

  logger.info({ baseUrl: process.env.API_BASE_URL || '(未设置)', tzOffset: tzOffsetHours, pollInterval: POLL_INTERVAL / 1000 }, '[配置] 启动参数');

  await ensureDatabase();
  await ensureFingerprintSecretConsistency();

  // auth-service 已接管 Token 管理
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
    server.listen(PORT, '127.0.0.1', () => {
      logger.info({ host: '127.0.0.1', port: PORT }, `[HTTP] 管理接口仅监听 http://127.0.0.1:${PORT}`);
    });
  } else {
    logger.info('[HTTP] 内置 HTTP 服务已禁用（PORT=0）');
  }

  // 启动后从数据库加载动态配置（白名单等），必须在首次 pollOrders 之前
  await reloadConstantsFromDB().catch(err => logger.warn({ err: (err as Error).message }, '[启动] 加载动态配置失败'));

  await startTelegramBot();

  logger.info({ interval: POLL_INTERVAL / 1000 }, `[轮询] 启动定时轮询，间隔 ${POLL_INTERVAL / 1000}s`);

  await sleep(5000);
  await pollOrders();

  let currentInterval = POLL_INTERVAL;
  let pollTimer: ReturnType<typeof setTimeout>;

  function scheduleNextPoll() {
    pollTimer = setTimeout(async () => {
      await pollOrders();

      if (consecutiveFailures > 0) {
        currentInterval = Math.min(5 * 60 * 1000, Math.min(POLL_INTERVAL * 4, currentInterval * 2));
      } else {
        currentInterval = POLL_INTERVAL;
      }

      scheduleNextPoll();
    }, currentInterval);
  }
  scheduleNextPoll();

  const notificationRetryTimer = setInterval(async () => {
    await retryUnsentNotifications();
  }, 5 * 60 * 1000);

  const autoReviewTimer = setInterval(async () => {
    await autoReviewExpiredOrders();
  }, 60 * 1000);

  const watchdogTimer = setInterval(() => {
    const elapsed = Date.now() - lastPollTime;
    const threshold = POLL_INTERVAL * 3;
    if (elapsed > threshold && !isPolling) {
      logger.warn({ elapsedSec: Math.round(elapsed / 1000) }, `[看门狗] 超过 ${Math.round(elapsed / 1000)}s 未成功轮询，强制触发`);
      pollOrders().catch(() => {});
    }
  }, 2 * 60 * 1000);

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

      // 同收款关联只需要近期窗口；每个会员仍保留一笔最旧以外的最新成功提款供 R41 比较。
      const confirmedHistoryCutoff = new Date(Date.now() - 365 * 86400000);
      const successfulWithdrawalDeleted = await dbHolder.db.$executeRaw`
        DELETE FROM "SuccessfulWithdrawal" AS old
        WHERE old."createTime" < ${confirmedHistoryCutoff}
          AND EXISTS (
            SELECT 1
            FROM "SuccessfulWithdrawal" AS newer
            WHERE newer."memberName" = old."memberName"
              AND newer."createTime" > old."createTime"
          )
      `;
      const profileContributionDeleted = await dbHolder.db.profileContribution.deleteMany({
        where: { createdAt: { lt: confirmedHistoryCutoff } },
      });

      if (lowDeleted.count > 0 || oldDeleted.count > 0 || highDeleted.count > 0 || staleUnnotified.count > 0 || feedbackInfoDeleted.count > 0 || successfulWithdrawalDeleted > 0 || profileContributionDeleted.count > 0) {
        logger.info({ lowDeleted: lowDeleted.count, oldDeleted: oldDeleted.count, highDeleted: highDeleted.count, staleUnnotified: staleUnnotified.count, feedbackDeleted: feedbackInfoDeleted.count, successfulWithdrawalDeleted, profileContributionDeleted: profileContributionDeleted.count }, `[清理] 删除 ${lowDeleted.count}条LOW(30d) ${oldDeleted.count}条MEDIUM(90d) ${highDeleted.count}条HIGH/CRITICAL(180d) ${staleUnnotified.count}条超期未通知(180d) ${feedbackInfoDeleted.count}条审核反馈(90d) ${successfulWithdrawalDeleted}条过期成功提款 ${profileContributionDeleted.count}条画像幂等记录`);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[清理] 数据自动清理失败');
    }
  }, 6 * 60 * 60 * 1000);

  // 启动后从数据库加载动态配置（白名单等）
  // 注：已在首次 pollOrders 之前调用，此处作为 DB 就绪后的二次确认

  logger.info('[启动] 🎉 风控机器人已完全启动（auth-service 管理 Token）');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, `[关闭] 收到 ${signal}，正在优雅关闭...`);
    clearTimeout(pollTimer);
    clearInterval(notificationRetryTimer);
    clearInterval(watchdogTimer);
    clearInterval(cleanupTimer);
    clearInterval(autoReviewTimer);
    // 排空进行中的通知，避免 Telegram 消息只发一半
    const pending = Array.from(notifyingLocks.values());
    if (pending.length > 0) {
      logger.info({ count: pending.length }, '[关闭] 等待进行中的通知完成...');
      await Promise.allSettled(pending);
      logger.info('[关闭] 所有进行中的通知已完成');
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
