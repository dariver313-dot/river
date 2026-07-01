import { createServer } from './server';
import path from 'path';
import dotenv from 'dotenv';
import { LRUCache } from 'lru-cache';
import { apiClient } from './api-client';
import { evaluateOrder, cleanupStaleCaches, updateMemberProfile, updateAgentProfile, getCacheStats } from './evaluator';
import { extractProxyCode, formatBeijingTime, getTzOffsetMs, getTzOffsetMinutes } from './utils';
import { startTelegramBot, sendRiskAlert, getBot, autoReviewExpiredOrders } from './telegram';
import { dbHolder, ensureDatabase } from './db';
import { getActiveRuleIds, applyRuleStates } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import { logger } from './logger';
import type { WithdrawOrder } from './types';
import { reloadConstantsFromDB } from './constants';
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

  let dbOk = false;       // DB 读取成功（可信任 existing 字段）
  let dbReadFailed = false; // DB 读取失败（需走乐观路径）

  const doNotify = async (): Promise<NotifyResult> => {
    // 5分钟内已通知过 → 直接跳过（内存缓存，所有路径生效）
    if (wasRecentlyNotified(orderNo)) {
      return 'skipped';
    }

    if (precheckedNotified === false) {
      dbOk = true;
    } else {
      try {
        const existing = await dbHolder.db.riskEval.findUnique({
          where: { orderId: orderNo },
          select: { notified: true },
        });
        dbOk = true;
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

    // 通知发送成功后，CAS 标记（防止并发重复通知）
    try {
      const r = await dbHolder.db.riskEval.updateMany({
        where: { orderId: orderNo, notified: false },
        data: { notified: true },
      });
      if (r.count === 0) {
        logger.info({ orderNo }, '[通知] CAS显示已被其他进程通知，跳过标记');
      }
    } catch (err) {
      logger.warn({ orderNo, err: (err as Error).message }, '[通知] CAS标记notified失败，但通知已发送');
    }

    if (messageId) {
      try {
        const ev = await dbHolder.db.riskEval.findUnique({ where: { orderId: orderNo }, select: { detail: true } });
        if (ev) {
          const d = JSON.parse(ev.detail || '{}');
          d.notifyMsgId = messageId;
          d.notifiedAt = Date.now();
          await dbHolder.db.riskEval.update({ where: { orderId: orderNo }, data: { detail: JSON.stringify(d) } });
        } else if (!dbReadFailed) {
          logger.warn({ orderNo }, '[通知] 通知已发送但DB记录不存在，无法保存 notifiedAt，该订单将无法自动审核');
        }
      } catch (err) { logger.warn({ orderNo, err: (err as Error).message }, '[通知] 保存 notifyMsgId 失败'); }
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

let isTrackingStatus = false;

async function trackOrderStatus(): Promise<void> {
  if (isTrackingStatus) return;
  isTrackingStatus = true;
  try {
    const BATCH_SIZE = 50;
    const MAX_PER_RUN = 500;
    let totalProcessed = 0;
    let lastCreatedAt: Date | undefined;

    // 顺序处理最旧的未通知订单（asc），基于游标分页避免 offset 偏移
    while (true) {
      const whereClause: any = { notified: false, finalStatus: '' };
      if (lastCreatedAt) {
        whereClause.createdAt = { gt: lastCreatedAt };
      }
      const unnotifiedEvals = await dbHolder.db.riskEval.findMany({
        where: whereClause,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
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
          const validRules = rawRules.filter((r) => activeRuleIds.has(r.id));
          return handleNotification(
            {
              orderNo: evalRecord.orderId,
              status: 1,
              memberName: evalRecord.memberName,
              member_name: evalRecord.memberName,
              memberId: evalRecord.memberId,
              member_id: evalRecord.memberId,
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
      // 更新游标为当前批次最后一条记录的 createdAt
      const lastEval = unnotifiedEvals[unnotifiedEvals.length - 1];
      if (lastEval?.createdAt) lastCreatedAt = lastEval.createdAt;
      // 批次间释放事件循环，避免长时间阻塞其他异步任务
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[追踪] 补发通知检查失败');
  } finally {
    isTrackingStatus = false;
  }
}

let isPolling = false;
let lastPollTime = 0;
let consecutiveFailures = 0;
let idleHeartbeatCounter = 0;
const IDLE_HEARTBEAT_INTERVAL = 6; // 每6次空闲周期输出一次心跳日志
const MAX_CONSECUTIVE_FAILURES = 5;

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

    const completedOrders = await apiClient.getAllWithdrawOrdersByStatuses([1, 2], dateRange);
    if (!completedOrders || completedOrders.length === 0) return;

    const unevaluated: string[] = [];
    for (const o of completedOrders) {
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
          const proxyCode = extractProxyCode(order) || result.proxyCode || '';

          await upsertRiskEval(result.orderId || orderNo, {
            totalScore: result.totalScore,
            riskLevel: result.riskLevel,
            triggeredRules: JSON.stringify(result.triggeredRules),
            detail: buildDetailJson(order, result, { source: 'recovery' }),
            memberId: result.memberId || memberId,
            memberName,
          });

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
              await upsertRiskEval(orderNo, {
                totalScore: 0,
                riskLevel: 'LOW',
                triggeredRules: '[]',
                detail: buildDetailJson(order, null, { evalFailed: true, retries, source: 'recovery' }),
                memberId: String(order.memberId || order.member_id || ''),
                memberName: order.memberName || order.member_name || '',
              });
              markEvaluated(orderNo);
              logger.warn({ orderNo, retries }, '[补查] 遗漏订单重试耗尽，写入兜底记录（不通知：评估失败无法确定风险等级）');
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
              await dbHolder.db.riskEval.update({
                where: { orderId: orderNo },
                data: {
                  totalScore: 0,
                  riskLevel: 'LOW',
                  triggeredRules: '[]',
                  detail: buildDetailJson(order, null, { evalFailed: true, retries, source: 'recovery-retry' }),
                },
              });
              markEvaluated(orderNo);
              logger.warn({ orderNo, retries }, '[补查] 重试订单重试耗尽，写入兜底记录（不通知：评估失败无法确定风险等级）');
            } catch (e) {
              logger.error({ orderNo, err: (e as Error).message }, '[补查] 重试兜底记录写入失败');
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
      logger.warn({ count: missedArr.length, sample: missedArr.slice(0, 5) }, `[补查] 发现 ${missedArr.length} 笔已完成但未评估的订单`);
      const missedOrders = completedOrders.filter(o => missedSet.has(String(o.orderNo || o.id)));
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
      const retryOrders = completedOrders.filter(o => retryCandidateSet.has(String(o.orderNo || o.id)));
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
    logger.debug({ err: (err as Error).message }, '[补查] 已完成订单补查失败');
  }
}

async function pollOrders() {
  if (isPolling) return;
  isPolling = true;

  try {
    const orders: WithdrawOrder[] = await apiClient.getPendingWithdrawOrders();

    if (!orders || orders.length === 0) {
      idleHeartbeatCounter++;
      if (idleHeartbeatCounter % IDLE_HEARTBEAT_INTERVAL === 0) {
        logger.info(`[轮询] 心跳 ${formatBeijingTime(undefined, 'time')} — 无待审核/处理中订单（近${IDLE_HEARTBEAT_INTERVAL}轮空闲）`);
      }
      consecutiveFailures = 0;
      return;
    }
    idleHeartbeatCounter = 0;

    const statusLabel = (s: number) => s === 1 ? '待审核' : s === 2 ? '处理中' : `status=${s}`;
    const statusCount: Record<number, number> = {};
    for (const o of orders) {
      const s = o.status ?? 0;
      statusCount[s] = (statusCount[s] || 0) + 1;
    }
    const statusSummary = Object.entries(statusCount).map(([s, c]) => `${statusLabel(Number(s))}${c}个`).join('，');
    logger.info({ count: orders.length, summary: statusSummary }, `[轮询] 获取到 ${orders.length} 个订单（${statusSummary}）`);

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
      idleHeartbeatCounter++;
      if (idleHeartbeatCounter % IDLE_HEARTBEAT_INTERVAL === 0) {
        logger.info(`[轮询] 心跳 ${formatBeijingTime(undefined, 'time')} — ${orders.length}个订单已全部评估（近${IDLE_HEARTBEAT_INTERVAL}轮无新单）`);
      }
      consecutiveFailures = 0;
      return;
    }
    idleHeartbeatCounter = 0;

    logger.info({ newCount: newOrders.length, total: orders.length }, `[轮询] 其中 ${newOrders.length} 个为新订单，开始并发评估`);

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

    const CONCURRENCY = newOrders.length > 30 ? 8 : newOrders.length > 15 ? 5 : newOrders.length > 5 ? 4 : 3;

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
              const memberName = order.memberName || order.member_name || '';
              await upsertRiskEval(orderId, {
                totalScore: 0, riskLevel: 'LOW', triggeredRules: '[]',
                detail: buildDetailJson(order, null, { evalFailed: true, retries }),
                memberId: String(order.memberId || order.member_id || ''),
                memberName,
              });
              markEvaluated(orderId);
              logger.warn({ orderNo: order.orderNo || order.id, retries }, '[评估] 重试耗尽，写入兜底记录（不通知：评估失败无法确定风险等级）');
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

          await upsertRiskEval(result.orderId || String(order.orderNo || order.id), {
            totalScore: result.totalScore,
            riskLevel: result.riskLevel,
            triggeredRules: JSON.stringify(result.triggeredRules),
            detail: buildDetailJson(order, result),
            memberId: result.memberId || String(order.memberId || order.member_id),
            memberName,
          });

          // DB 持久化成功后才标记为已评估
          if (result.triggeredRules.length > 0) {
            markEvaluated(String(order.orderNo || order.id));
          } else {
            // 零违规订单写入主缓存(2h TTL)，与有违规订单一致
            markEvaluated(String(order.orderNo || order.id));
          }

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

    cleanupStaleCaches();

    recoverPendingOrders().catch(err => logger.error({ err: (err as Error).message }, '[补查] 异步补查异常'));

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
      logger.error('[轮询] 连续失败次数过多，清除 Token 等待重新认证');
      // auth-service 管理 Token，失败重试即可
      // 不重置 consecutiveFailures：token 仍无效，退避应持续到成功轮询为止
    }
  } finally {
    isPolling = false;
    lastPollTime = Date.now();
  }
}

const server = createServer({
  getLastPollTime: () => lastPollTime,
  getPollInterval: () => POLL_INTERVAL,
  evaluatedOrderCache,
});

async function main() {
  logger.info('========================================');
  logger.info('  🤖 风控提醒机器人 v5.0');
  logger.info('========================================');

  const envPath = path.resolve(process.cwd(), '.env');
  dotenv.config({ path: envPath });
  logger.info('[Env] 已通过 dotenv 加载 .env 文件');

  POLL_INTERVAL = Math.max(parseInt(process.env.POLL_INTERVAL || '15', 10) * 1000, 10000);
  PORT = parseInt(process.env.PORT || '0', 10);

  const missingEnvs: string[] = [];
  // AUTH_SERVICE_URL 和 TELEGRAM_BOT_TOKEN 为必需；AUTH_API_KEY 为必需（连接 auth-service）；
  // DATABASE_URL 由 ensureDatabase() 自动生成（SQLite 文件路径），无需强制配置
  if (!process.env.AUTH_SERVICE_URL) missingEnvs.push('AUTH_SERVICE_URL');
  if (!process.env.AUTH_API_KEY) missingEnvs.push('AUTH_API_KEY');
  if (!process.env.TELEGRAM_BOT_TOKEN) missingEnvs.push('TELEGRAM_BOT_TOKEN');
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

  server.listen(PORT, () => {
    logger.info({ port: PORT }, `[HTTP] 服务器运行在 http://localhost:${PORT}`);
  });

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

  const statusTrackTimer = setInterval(async () => {
    await trackOrderStatus();
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

  const dailyReportTimer = setInterval(async () => {
    try {
      const now = new Date();
      const tzOffsetHours = getTzOffsetMinutes() / 60;
      const localHour = Math.floor((now.getUTCHours() + tzOffsetHours + 24) % 24);
      if (localHour < 9 || localHour >= 10) return;

      const lastReport = await dbHolder.db.botConfig.findUnique({ where: { key: 'LAST_DAILY_REPORT' } });
      const localDateStr = new Date(now.getTime() + getTzOffsetMs()).toISOString().slice(0, 10);
      if (lastReport?.value === localDateStr) return;

      const { start: todayStart } = apiClient.getTimezoneDateRange();
      const yesterdayStart = todayStart - 86400000;
      const yesterdayWhere = { createdAt: { gte: new Date(yesterdayStart), lt: new Date(todayStart) } };

      const [total, highRisk, mediumRisk] = await Promise.all([
        dbHolder.db.riskEval.count({ where: yesterdayWhere }),
        dbHolder.db.riskEval.count({ where: { ...yesterdayWhere, riskLevel: { in: ['HIGH', 'CRITICAL'] } } }),
        dbHolder.db.riskEval.count({ where: { ...yesterdayWhere, riskLevel: 'MEDIUM' } }),
      ]);

      let topRules = '无';
      try {
        const nonLowEvals = await dbHolder.db.riskEval.findMany({
          where: {
            createdAt: { gte: new Date(yesterdayStart), lt: new Date(todayStart) },
            riskLevel: { not: 'LOW' },
          },
          select: { triggeredRules: true },
        });
        const ruleCount: Record<string, number> = {};
        for (const row of nonLowEvals) {
          try {
            const rules = JSON.parse(row.triggeredRules || '[]');
            for (const r of rules) {
              ruleCount[r.id] = (ruleCount[r.id] || 0) + 1;
            }
          } catch {}
        }
        topRules = Object.entries(ruleCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, c]) => `${id}(${c}次)`).join('、') || '无';
      } catch {}

      const text = [
        `📊 每日风控报告（${formatBeijingTime(yesterdayStart, 'date')}）`,
        ``,
        `总评估：${total} 笔`,
        `高风险：${highRisk} 笔`,
        `中风险：${mediumRisk} 笔`,
        `TOP5规则：${topRules || '无'}`,
      ].join('\n');

      const chatId = await dbHolder.db.botConfig.findUnique({ where: { key: 'NOTIFY_CHAT_ID' } });
      if (chatId?.value) {
        try { await getBot().api.sendMessage(chatId.value, text); } catch {}
      }

      await dbHolder.db.botConfig.upsert({
        where: { key: 'LAST_DAILY_REPORT' },
        update: { value: localDateStr },
        create: { key: 'LAST_DAILY_REPORT', value: localDateStr },
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[报告] 每日风控报告生成失败');
    }
  }, 10 * 60 * 1000);

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

      if (lowDeleted.count > 0 || oldDeleted.count > 0 || highDeleted.count > 0 || staleUnnotified.count > 0 || feedbackInfoDeleted.count > 0) {
        logger.info({ lowDeleted: lowDeleted.count, oldDeleted: oldDeleted.count, highDeleted: highDeleted.count, staleUnnotified: staleUnnotified.count, feedbackDeleted: feedbackInfoDeleted.count }, `[清理] 删除 ${lowDeleted.count}条LOW(30d) ${oldDeleted.count}条MEDIUM(90d) ${highDeleted.count}条HIGH/CRITICAL(180d) ${staleUnnotified.count}条超期未通知(180d) ${feedbackInfoDeleted.count}条审核反馈(90d)`);
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
    clearInterval(statusTrackTimer);
    clearInterval(watchdogTimer);
    clearInterval(dailyReportTimer);
    clearInterval(cleanupTimer);
    clearInterval(autoReviewTimer);
    // 排空进行中的通知，避免 Telegram 消息只发一半
    const pending = Array.from(notifyingLocks.values());
    if (pending.length > 0) {
      logger.info({ count: pending.length }, '[关闭] 等待进行中的通知完成...');
      await Promise.allSettled(pending);
      logger.info('[关闭] 所有进行中的通知已完成');
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
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
