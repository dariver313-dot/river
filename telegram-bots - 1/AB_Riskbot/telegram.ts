import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { BetRecord, LoginLogItem, WithdrawOrder } from './types';
import { apiClient } from './api-client';
import { invalidateMemberReviewedPeriods } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import { dbHolder } from './db';
import { LRUCache } from 'lru-cache';
import { logger } from './logger';
import { fmtNum, extractProxyCode, formatBeijingTime, parseTimeStr, normalizeMemberRemark } from './utils';
import { extractTwoSideDirection, expandDirections, isMutexDirection } from './rules';
import { isAgentWhitelisted } from './constants';

const LEVEL_CONFIG: Record<string, { icon: string; label: string; head: string }> = {
  CRITICAL: { icon: '🔴', label: '严重风险', head: '🔴' },
  HIGH:     { icon: '🟠', label: '高风险',   head: '⚠️' },
  MEDIUM:   { icon: '🟡', label: '中等风险', head: '🟡' },
  LOW:      { icon: '🟢', label: '低风险',   head: '✅' },
};

const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
};

let bot: Bot | null = null;

let notifyChatId: number | string | null = null;
let notifyChatIdLastCheck = 0;
const NOTIFY_CHAT_ID_CACHE_TTL = 30 * 1000;

let tgFailCount = 0;
const TG_CIRCUIT_THRESHOLD = 3;
const TG_CIRCUIT_COOLDOWN = 5 * 60 * 1000;
let tgCircuitOpenUntil = 0;

async function loadChatIdFromDB(): Promise<string | null> {
  try {
    const config = await dbHolder.db.botConfig.findUnique({ where: { key: 'NOTIFY_CHAT_ID' } });
    return config?.value || null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Telegram] 加载通知群组 Chat ID 失败，数据库可能未就绪');
    return null;
  }
}

async function saveChatIdToDB(chatId: number | string): Promise<void> {
  await dbHolder.db.botConfig.upsert({
    where: { key: 'NOTIFY_CHAT_ID' },
    update: { value: String(chatId) },
    create: { key: 'NOTIFY_CHAT_ID', value: String(chatId) },
  });
}

async function initChatId(): Promise<void> {
  // 优先环境变量 → 数据库 → 无
  const envId = process.env.NOTIFY_CHAT_ID || '';
  if (envId) {
    notifyChatId = envId;
    await saveChatIdToDB(envId);
    logger.info({ chatId: envId }, `[Telegram] 从环境变量加载通知群组: ${envId}`);
    return;
  }
  const saved = await loadChatIdFromDB();
  if (saved) {
    notifyChatId = saved;
    logger.info({ chatId: saved }, `[Telegram] 从数据库加载通知群组: ${saved}`);
  } else {
    logger.info('[Telegram] 未配置通知群组，请在群组中发送 /bind 绑定，或在 .env 中设置 NOTIFY_CHAT_ID');
  }
}

export function getNotifyChatId(): number | string | null {
  return notifyChatId;
}

function buildActionKeyboard(orderId: string, reviewed = false): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (!reviewed) keyboard.text('✅ 人工审核', `feedback:${orderId}:review`);
  return keyboard
    .text('👥 团体画像', `feedback:${orderId}:profile`)
    .text('🎯 团体对打', `feedback:${orderId}:hedge`);
}

export function withReviewStatus(text: string, status: '已人工审核' | '已自动审核'): string {
  const firstLineEnd = text.indexOf('\n');
  const title = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  if (title.includes(`· ${status}`)) return text;
  const updatedTitle = `${title} · ${status}`;
  return firstLineEnd === -1 ? updatedTitle : `${updatedTitle}${text.slice(firstLineEnd)}`;
}

/** Telegram 对重复 edit 返回 400，表示消息已经是预期内容，不应补发新消息。 */
export function isTelegramMessageNotModified(error: unknown): boolean {
  return /message is not modified/i.test((error as Error | undefined)?.message || '');
}

function safeTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  // 仅在需要截断时才展开 Unicode 字符，避免不必要的 Array.from 分配
  const chars = [...str];
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen).join('');
}

function formatDisplaySymbols(text: string): string {
  return text.replace(/↔/g, ' - ');
}

const DEFAULT_ADMIN_USER_IDS = ['8373296041'];
const infoQueryLocks = new Set<string>();
const hedgeQueryLocks = new Set<string>();
// 人工审核与自动审核使用同一把锁，避免并发编辑同一条通知。
const reviewLocks = new Set<string>();
const PROFILE_IP_LIMIT = 5;
const PROFILE_DEVICE_LIMIT = 5;
const PROFILE_MEMBER_LIMIT = 50;
const PROFILE_DISPLAY_LIMIT = 20;
const HEDGE_MEMBER_LIMIT = 40;
const HEDGE_DISPLAY_LIMIT = 10;
const PROFILE_CACHE_TTL = 5 * 60 * 1000;
const PROFILE_EXPAND_DEPTH = 2;
const PROFILE_EXPAND_MEMBER_LIMIT = 20;
const PROFILE_PUBLIC_IP_LIMIT = 500;
const PROFILE_PUBLIC_DEVICE_LIMIT = 100;
const PROFILE_NOTE_LIMIT = 5;

function getAdminUserIds(): Set<number> {
  const ids = [
    ...DEFAULT_ADMIN_USER_IDS,
    ...(process.env.ADMIN_USER_IDS || '').split(/[,\s]+/),
  ]
    .map(id => Number(id.trim()))
    .filter(id => Number.isSafeInteger(id) && id > 0);
  return new Set(ids);
}

function isAdminUser(userId: number | undefined): boolean {
  return !!userId && getAdminUserIds().has(userId);
}

async function requireAdminCommand(ctx: Context): Promise<boolean> {
  if (isAdminUser(ctx.from?.id)) return true;
  await ctx.reply('⛔ 仅管理员可以操作');
  return false;
}

async function requireAdminCallback(ctx: Context): Promise<boolean> {
  if (isAdminUser(ctx.from?.id)) return true;
  await ctx.answerCallbackQuery({ text: '仅管理员可以操作', show_alert: true }).catch(() => {});
  return false;
}

/** 人工和超时自动审核共用：订单状态与游戏违规期号必须在同一事务提交。 */
async function recordReviewOutcome(orderId: string): Promise<boolean> {
  let memberId = '';
  const recorded = await dbHolder.db.$transaction(async (tx) => {
    const evalRecord = await tx.riskEval.findUnique({ where: { orderId } });
    if (!evalRecord || evalRecord.feedback !== '') return false;

    const updated = await tx.riskEval.updateMany({
      where: { orderId, feedback: '' },
      data: { feedback: 'review' },
    });
    if (updated.count === 0) return false;

    memberId = evalRecord.memberId || '';
    let triggeredRules: Array<{ id: string }> = [];
    try { triggeredRules = JSON.parse(evalRecord.triggeredRules || '[]'); } catch {}
    let periodInfo = '';
    try { periodInfo = JSON.parse(evalRecord.detail || '{}').periodInfo || ''; } catch {}
    for (const rule of triggeredRules) {
      await tx.ruleFeedback.upsert({
        where: { evalId_ruleId: { evalId: evalRecord.id, ruleId: rule.id } },
        update: { feedback: 'review', memberId, periodInfo: ['R24', 'R25', 'R26'].includes(rule.id) ? periodInfo : '' },
        create: {
          evalId: evalRecord.id,
          ruleId: rule.id,
          feedback: 'review',
          memberId,
          periodInfo: ['R24', 'R25', 'R26'].includes(rule.id) ? periodInfo : '',
        },
      });
    }
    return true;
  });

  if (recorded && memberId) invalidateMemberReviewedPeriods(memberId);
  return recorded;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getProfileLoginFetchOptions(signal?: AbortSignal): { maxPages: number; pageSize: number; signal?: AbortSignal } {
  const options: { maxPages: number; pageSize: number; signal?: AbortSignal } = {
    maxPages: parsePositiveInt(process.env.PROFILE_LOGIN_MAX_PAGES, 5),
    pageSize: parsePositiveInt(process.env.PROFILE_LOGIN_PAGE_SIZE, 100),
  };
  if (signal) options.signal = signal;
  return options;
}

interface GroupMemberHit {
  memberName: string;
  reasons: Set<string>;
  latestLoginAt: number;
}

interface GroupProfile {
  memberName: string;
  uplineName: string;
  ips: string[];
  devices: string[];
  relatedMembers: GroupMemberHit[];
  skippedValues: string[];
}

interface MemberEnvironment {
  memberName: string;
  uplineName: string;
  ips: string[];
  devices: string[];
}

const groupProfileCache = new LRUCache<string, GroupProfile>({
  max: 500,
  ttl: PROFILE_CACHE_TTL,
});

function shortDeviceName(device: string): string {
  return device.split(':')[0] || device;
}

function getPagedTotalCount(res: { totalNum?: string | number; items?: unknown[] } | null | undefined, fallback: number): number {
  const n = parseInt(String(res?.totalNum || ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function latestLoginTimes(logs: LoginLogItem[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const log of logs) {
    const name = String(log.memberName || '').trim();
    if (!name) continue;
    const ts = parseTimeStr(log.loginTime as string | number | undefined);
    const prev = times.get(name) || 0;
    if (ts > prev) times.set(name, ts);
    if (!times.has(name)) times.set(name, 0);
  }
  return times;
}

function sortValuesByLatestLog(logs: LoginLogItem[], field: 'loginIp' | 'device', limit: number): string[] {
  const latest = new Map<string, number>();
  for (const log of logs) {
    const value = String(log[field] || '').trim();
    if (!value) continue;
    const ts = parseTimeStr(log.loginTime as string | number | undefined);
    const prev = latest.get(value) || 0;
    if (ts > prev) latest.set(value, ts);
    if (!latest.has(value)) latest.set(value, 0);
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function mergeGroupHit(map: Map<string, GroupMemberHit>, name: string, reason: string, latestLoginAt = 0): void {
  const memberName = String(name || '').trim();
  if (!memberName) return;
  const hit = map.get(memberName) || { memberName, reasons: new Set<string>(), latestLoginAt: 0 };
  hit.reasons.add(reason);
  if (latestLoginAt > hit.latestLoginAt) hit.latestLoginAt = latestLoginAt;
  map.set(memberName, hit);
}

function addProfileNote(notes: string[], note: string): void {
  if (notes.length >= PROFILE_NOTE_LIMIT || notes.includes(note)) return;
  notes.push(note);
}

function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (next) next();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      runNext();
    }
  };
}

type TelegramLimiter = <T>(task: () => Promise<T>) => Promise<T>;
let heavyTelegramLimiter: TelegramLimiter | null = null;

function limitHeavyTelegramQuery<T>(task: () => Promise<T>): Promise<T> {
  if (!heavyTelegramLimiter) {
    heavyTelegramLimiter = createLimiter(parsePositiveInt(process.env.HEAVY_QUERY_CONCURRENCY, 2));
  }
  return heavyTelegramLimiter(task);
}

async function withTimeout(label: string, timeoutMs: number, task: (signal: AbortSignal) => Promise<string>): Promise<string> {
  return new Promise<string>((resolve) => {
    const abortController = new AbortController();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        abortController.abort();
        resolve(`⏰ ${label}超时（${timeoutMs / 1000}秒），请稍后重试`);
      }
    }, timeoutMs);
    task(abortController.signal).then((text) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(text);
      }
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(`❌ ${label}失败: ${err.message}`);
      }
    });
  });
}

async function fetchMemberEnvironment(memberName: string, loginFetchOptions: ReturnType<typeof getProfileLoginFetchOptions>): Promise<MemberEnvironment> {
  let uplineName = '';
  // Platform A 无可靠的全历史登录时间字段；按钮查询明确限定为当前北京日。
  const loginLogsRes = await apiClient.getLoginLogsByMember(memberName, apiClient.getTimezoneDateRange(), loginFetchOptions);
  const ownLogs = loginLogsRes?.items || [];
  const ips = sortValuesByLatestLog(ownLogs, 'loginIp', PROFILE_IP_LIMIT);
  const devices = sortValuesByLatestLog(ownLogs, 'device', PROFILE_DEVICE_LIMIT);

  try {
    const selfRes = await apiClient.getMemberInfoByName(memberName);
    const self = selfRes?.items?.[0];
    uplineName = self?.agencyMemberName || self?.proxyCode || self?.parentName || '';
    const lastIp = String(self?.lastLoginIp || '').trim();
    const lastDevice = String(self?.lastLoginDeviceClientId || '').trim();
    if (lastIp && !ips.includes(lastIp)) ips.unshift(lastIp);
    if (lastDevice && !devices.includes(lastDevice)) devices.unshift(lastDevice);
  } catch { /* ignore */ }

  return {
    memberName,
    uplineName,
    ips: [...new Set(ips)].slice(0, PROFILE_IP_LIMIT),
    devices: [...new Set(devices)].slice(0, PROFILE_DEVICE_LIMIT),
  };
}

async function buildGroupProfile(memberName: string, abortSignal?: AbortSignal): Promise<GroupProfile> {
  const cacheKey = memberName.trim().toLowerCase();
  const cached = groupProfileCache.get(cacheKey);
  if (cached) return cached;

  const related = new Map<string, GroupMemberHit>();
  const queuedNames = new Set<string>([cacheKey]);
  const expandedNames = new Set<string>();
  const skippedValues: string[] = [];
  const loginFetchOptions = getProfileLoginFetchOptions(abortSignal);
  const rootEnv = await fetchMemberEnvironment(memberName, loginFetchOptions);
  if (abortSignal?.aborted) throw new Error('查询已取消');
  const queue: Array<{ name: string; depth: number; env?: MemberEnvironment }> = [{ name: memberName, depth: 0, env: rootEnv }];

  const addRelated = (name: string, reason: string, latestLoginAt: number, nextDepth: number): void => {
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName === memberName) return;
    if (isAgentWhitelisted(cleanName)) return;
    if (!related.has(cleanName) && related.size >= PROFILE_MEMBER_LIMIT) return;
    mergeGroupHit(related, cleanName, reason, latestLoginAt);

    const key = cleanName.toLowerCase();
    if (nextDepth < PROFILE_EXPAND_DEPTH && queuedNames.size < PROFILE_EXPAND_MEMBER_LIMIT + 1 && !queuedNames.has(key)) {
      queuedNames.add(key);
      queue.push({ name: cleanName, depth: nextDepth });
    }
  };

  while (queue.length > 0 && expandedNames.size < PROFILE_EXPAND_MEMBER_LIMIT + 1) {
    if (abortSignal?.aborted) throw new Error('查询已取消');
    const current = queue.shift()!;
    const currentKey = current.name.toLowerCase();
    if (expandedNames.has(currentKey) || current.depth >= PROFILE_EXPAND_DEPTH) continue;
    expandedNames.add(currentKey);

    const env = current.env || await fetchMemberEnvironment(current.name, loginFetchOptions);
    const reasonPrefix = current.name === memberName ? '' : `经${current.name} `;
    const nextDepth = current.depth + 1;

    await Promise.all(env.ips.slice(0, PROFILE_IP_LIMIT).map(async (ip) => {
      try {
        const res = await apiClient.getLoginLogsByIp(ip, undefined, loginFetchOptions);
        const logs = res?.items || [];
        const total = getPagedTotalCount(res, logs.length);
        if (total > PROFILE_PUBLIC_IP_LIMIT) {
          addProfileNote(skippedValues, `公共IP ${ip}(${total}人)`);
          return;
        }
        const latest = latestLoginTimes(logs);
        for (const [name, ts] of latest) {
          if (name !== current.name) addRelated(name, `${reasonPrefix}同IP ${ip}`, ts, nextDepth);
        }
      } catch (err) {
        if (abortSignal?.aborted) throw err;
        /* ignore single ip */
      }
    }));
    if (abortSignal?.aborted) throw new Error('查询已取消');

    await Promise.all(env.devices.slice(0, PROFILE_DEVICE_LIMIT).map(async (device) => {
      try {
        const res = await apiClient.getLoginLogsByDevice(device, undefined, loginFetchOptions);
        const logs = res?.items || [];
        const total = getPagedTotalCount(res, logs.length);
        if (total > PROFILE_PUBLIC_DEVICE_LIMIT) {
          addProfileNote(skippedValues, `公共设备 ${shortDeviceName(device)}(${total}人)`);
          return;
        }
        const latest = latestLoginTimes(logs);
        for (const [name, ts] of latest) {
          if (name !== current.name) addRelated(name, `${reasonPrefix}同设备 ${shortDeviceName(device)}`, ts, nextDepth);
        }
      } catch (err) {
        if (abortSignal?.aborted) throw err;
        /* ignore single device */
      }
    }));
    if (abortSignal?.aborted) throw new Error('查询已取消');
  }

  const relatedMembers = [...related.values()]
    .filter(hit => hit.memberName !== memberName)
    .sort((a, b) => b.reasons.size - a.reasons.size || a.memberName.localeCompare(b.memberName))
    .slice(0, PROFILE_MEMBER_LIMIT);

  const profile = {
    memberName,
    uplineName: rootEnv.uplineName,
    ips: rootEnv.ips,
    devices: rootEnv.devices,
    relatedMembers,
    skippedValues,
  };
  if (abortSignal?.aborted) throw new Error('查询已取消');
  groupProfileCache.set(cacheKey, profile);
  return profile;
}

function buildGroupProfileText(profile: GroupProfile): string {
  const lines = [
    `👥 ${profile.memberName} 团体画像`,
    `上级：${profile.uplineName || '-'}`,
    `当天登录IP：${profile.ips.length ? profile.ips.join('、') : '-'}`,
    `当天登录设备：${profile.devices.length ? profile.devices.map(shortDeviceName).join('、') : '-'}`,
    '',
  ];

  if (profile.skippedValues.length > 0) {
    lines.push(`已跳过公共环境：${profile.skippedValues.join('、')}`);
    lines.push('');
  }

  if (profile.relatedMembers.length === 0) {
    lines.push('✅ 暂未发现同IP/同设备关联账号');
    return lines.join('\n');
  }

  const shown = profile.relatedMembers.slice(0, PROFILE_DISPLAY_LIMIT);
  lines.push(`同IP/同设备关联账号：${profile.relatedMembers.length} 个（最多扩展2层，已排除白名单）`);
  shown.forEach((hit, idx) => {
    const reason = [...hit.reasons].slice(0, 3).join(' / ');
    lines.push(`${idx + 1}. ${hit.memberName}（${reason}）`);
  });
  const hidden = profile.relatedMembers.length - shown.length;
  if (hidden > 0) lines.push(`...另有 ${hidden} 个账号隐藏`);

  return lines.join('\n').slice(0, 4096);
}

function queryGroupProfile(memberName: string): Promise<string> {
  return limitHeavyTelegramQuery(() => withTimeout('团体画像查询', 25 * 1000, async (signal) => {
    if (isAgentWhitelisted(memberName)) return `👥 ${memberName}：白名单账号，已跳过同IP/同设备深挖`;
    return buildGroupProfileText(await buildGroupProfile(memberName, signal));
  }));
}

function sumBetAmount(bets: BetRecord[]): number {
  return bets.reduce((s, b) => s + (parseFloat(String(b.amount || 0)) || 0), 0);
}

function sumProfit(bets: BetRecord[]): number {
  return bets.reduce((s, b) => s + (parseFloat(String(b.profit || 0)) || 0), 0);
}

function queryGroupHedge(memberName: string): Promise<string> {
  return limitHeavyTelegramQuery(() => withTimeout('团体对打查询', 35 * 1000, async (signal) => {
    if (isAgentWhitelisted(memberName)) return `🎯 ${memberName}：白名单账号，已跳过团体对打`;
    const profile = await buildGroupProfile(memberName, signal);
    const candidateNames = [memberName, ...profile.relatedMembers.map(hit => hit.memberName)]
      .filter((name, idx, arr) => name && arr.indexOf(name) === idx)
      .filter(name => !isAgentWhitelisted(name))
      .slice(0, HEDGE_MEMBER_LIMIT);
    if (candidateNames.length < 2) return `🎯 ${memberName}：未找到可用于团体对打检测的关联账号`;

    const dateRange = apiClient.getTimezoneDateRange();
    const allBetsMap = new Map<string, BetRecord[]>();
    for (let i = 0; i < candidateNames.length; i += 5) {
      if (signal.aborted) throw new Error('查询已取消');
      const batch = candidateNames.slice(i, i + 5);
      await Promise.all(batch.map(async (name) => {
        try {
          const res = await apiClient.getMemberBets(name, 1, dateRange, 5, { signal });
          const bets = (res?.items || []) as BetRecord[];
          if (bets.length > 0) allBetsMap.set(name, bets);
        } catch (err) {
          if (signal.aborted) throw err;
          /* ignore single member */
        }
      }));
    }

    if (!allBetsMap.has(memberName)) return `🎯 ${memberName}：今日无投注记录，无法判断团体对打`;
    if (allBetsMap.size < 2) return `🎯 ${memberName}：关联账号今日无投注记录`;

    const issueGroups = new Map<string, Map<string, BetRecord[]>>();
    for (const [name, bets] of allBetsMap) {
      for (const bet of bets) {
        const key = `${bet.lotteryName || ''} ${bet.issue || ''} ${bet.playClassName || ''}`;
        if (!issueGroups.has(key)) issueGroups.set(key, new Map<string, BetRecord[]>());
        const memberBets = issueGroups.get(key)!.get(name) || [];
        memberBets.push(bet);
        issueGroups.get(key)!.set(name, memberBets);
      }
    }

    const hits: string[] = [];
    for (const [issueKey, memberMap] of issueGroups) {
      if (memberMap.size < 2) continue;
      const members = [...memberMap.entries()];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const [name1, bets1] = members[i];
          const [name2, bets2] = members[j];
          const dirs1 = new Set(bets1.flatMap(b => expandDirections(extractTwoSideDirection(String(b.numbers || '')))));
          const dirs2 = new Set(bets2.flatMap(b => expandDirections(extractTwoSideDirection(String(b.numbers || '')))));
          if (dirs1.size === 0 || dirs2.size === 0) continue;

          let mutexPair = '';
          for (const d1 of dirs1) {
            for (const d2 of dirs2) {
              if (isMutexDirection(d1, d2)) {
                mutexPair = `${d1}↔${d2}`;
                break;
              }
            }
            if (mutexPair) break;
          }

          const amt1 = sumBetAmount(bets1);
          const amt2 = sumBetAmount(bets2);
          const closeAmount = Math.max(amt1, amt2) > 0 && Math.abs(amt1 - amt2) / Math.max(amt1, amt2) <= 0.2;
          const heavySameIssue = !mutexPair && closeAmount && bets1.length + bets2.length >= 6 && Math.min(amt1, amt2) >= 200;
          if (mutexPair || heavySameIssue) {
            const tag = mutexPair ? `对打 ${mutexPair}` : '疑似对冲';
            hits.push(`${issueKey} ${tag}：${name1} ${amt1.toFixed(0)} vs ${name2} ${amt2.toFixed(0)}`);
          }
        }
      }
    }

    const allBets = [...allBetsMap.values()].flat();
    const totalBet = sumBetAmount(allBets);
    const totalProfit = sumProfit(allBets);
    const pnlRate = totalBet > 0 ? Math.abs(totalProfit) / totalBet : 1;
    if (totalBet >= 10000 && pnlRate < 0.02) {
      const profitText = totalProfit >= 0 ? '微盈' : '微亏';
      hits.unshift(`团体盈亏抵消：${allBetsMap.size}个账号投注${totalBet.toFixed(0)}，${profitText}${Math.abs(totalProfit).toFixed(0)}，盈亏率${(pnlRate * 100).toFixed(2)}%`);
    }

    const header = `🎯 ${memberName} 团体对打检测\n关联账号：${candidateNames.length - 1} 个，今日有投注账号：${allBetsMap.size} 个`;
    if (hits.length === 0) return `${header}\n✅ 未发现明显团体对打/对冲`;

    const shown = hits.slice(0, HEDGE_DISPLAY_LIMIT);
    const hidden = hits.length - shown.length;
    return formatDisplaySymbols(`${header}\n${shown.map(s => `🔴 ${s}`).join('\n')}${hidden > 0 ? `\n...另有 ${hidden} 条隐藏` : ''}`.slice(0, 4096));
  }));
}

function registerBotHandlers(b: Bot): void {
  b.command('bind', async (ctx) => {
    if (!await requireAdminCommand(ctx)) return;
    if (!['group', 'supergroup'].includes(ctx.chat?.type || '')) {
      await ctx.reply('请在需要接收风控通知的群组中发送 /bind');
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId) {
      notifyChatId = chatId;
      await saveChatIdToDB(chatId);
      await ctx.reply('✅ 已绑定');
    }
  });

  b.callbackQuery(/^feedback:(.+):(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const action = ctx.match[2];

    if (!await requireAdminCallback(ctx)) return;

    if (action === 'review') {
      if (reviewLocks.has(orderId)) {
        await ctx.answerCallbackQuery({ text: '审核处理中，请稍候...' }).catch(() => {});
        return;
      }
      reviewLocks.add(orderId);
      try {
        const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
        if (!evalRecord) {
          await ctx.answerCallbackQuery({ text: '未找到该订单的风控记录', show_alert: true }).catch(() => {});
          return;
        }
        if (evalRecord.feedback !== '') {
          await ctx.answerCallbackQuery({ text: '该订单已审核' }).catch(() => {});
          return;
        }

        const message = ctx.callbackQuery.message;
        const messageText = message && 'text' in message ? message.text : '';
        if (!messageText) {
          await ctx.answerCallbackQuery({ text: '无法更新原通知，请稍后重试', show_alert: true }).catch(() => {});
          return;
        }

        if (!messageText.includes('· 已人工审核')) {
          await ctx.editMessageText(withReviewStatus(messageText, '已人工审核'), {
            // 先保留按钮；数据库暂时失败时管理员可以再次点击补写审核记录。
            reply_markup: buildActionKeyboard(orderId),
          });
        }
        const recorded = await recordReviewOutcome(orderId);
        if (recorded) {
          await ctx.editMessageReplyMarkup({ reply_markup: buildActionKeyboard(orderId, true) }).catch((err) => {
            logger.warn({ orderId, err: (err as Error).message }, '[Telegram] 人工审核后移除按钮失败');
          });
        }
        await ctx.answerCallbackQuery({ text: recorded ? '已人工审核' : '订单状态已变化' }).catch(() => {});
        if (recorded) logger.info({ orderId, memberName: evalRecord.memberName }, '[Telegram] 订单已人工审核');
      } catch (err) {
        logger.warn({ orderId, err: (err as Error).message }, '[Telegram] 人工审核失败');
        await ctx.answerCallbackQuery({ text: '人工审核失败，请重试', show_alert: true }).catch(() => {});
      } finally {
        reviewLocks.delete(orderId);
      }
      return;
    }

    if (action === 'info' || action === 'profile') {
      if (infoQueryLocks.has(orderId)) {
        await ctx.answerCallbackQuery({ text: '查询进行中，请稍候...' });
        return;
      }
      infoQueryLocks.add(orderId);
      try {
        await ctx.answerCallbackQuery({ text: '正在查询团体画像...' });
        try {
          const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
          const memberName = evalRecord?.memberName || '';
          if (!memberName) {
            await ctx.reply('❌ 未找到会员信息');
            return;
          }
          const waitMsg = await ctx.reply(`👥 正在查询 ${memberName} 的团体画像...`);
          const resultText = await queryGroupProfile(memberName);
          await b.api.editMessageText(waitMsg.chat.id, waitMsg.message_id, resultText);
        } catch (err) {
          await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
        }
      } finally {
        infoQueryLocks.delete(orderId);
      }
      return;
    }

    if (action === 'hedge') {
      if (hedgeQueryLocks.has(orderId)) {
        await ctx.answerCallbackQuery({ text: '查询进行中，请稍候...' });
        return;
      }
      hedgeQueryLocks.add(orderId);
      try {
        await ctx.answerCallbackQuery({ text: '正在查询团体对打...' });
        try {
          const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
          const memberName = evalRecord?.memberName || '';
          if (!memberName) {
            await ctx.reply('❌ 未找到会员信息');
            return;
          }
          const waitMsg = await ctx.reply(`🎯 正在查询 ${memberName} 的团体对打...`);
          const resultText = await queryGroupHedge(memberName);
          await b.api.editMessageText(waitMsg.chat.id, waitMsg.message_id, resultText);
        } catch (err) {
          await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
        }
      } finally {
        hedgeQueryLocks.delete(orderId);
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: '无效操作' }).catch(() => {});
  });
}

// ============================================================
// 风控告警消息文本构建（纯函数，sendRiskAlert 和 autoReview 共用）
// ============================================================

interface AlertTextParams {
  riskLevel: string;
  totalScore: number;
  memberName: string;
  proxyCode: string;
  balance: string | number;
  depositCount: number;
  withdrawCount: number;
  rechargeWithdrawDiff: number;
  totalRecharge?: number;
  totalWithdraw?: number;
  vipLevel?: number | string;
  sumBet?: number;
  daysSinceReg?: number;
  receivingBank: string;
  receivingName: string;
  registerTime: string;
  amount: string | number;
  triggeredRules: Array<{ id: string; name?: string; severity?: string; reason: string }>;
  isEarlyMorning?: boolean;
  topGameTypes?: string;
  remark?: string;
}

function countGameViolationKeys(parts: string[]): number {
  const keys = new Set<string>();
  for (const raw of parts) {
    const text = raw.trim();
    if (!text) continue;
    const beforeColon = text.split(/[：:]/, 1)[0].trim();
    const tokens = beforeColon.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      keys.add(`${tokens[0]} ${tokens[1]}`);
    } else {
      keys.add(beforeColon || text);
    }
  }
  return keys.size || parts.length;
}

function buildGameViolationHeader(icon: string, ruleName: string, parts: string[], shownCount: number): string {
  const entryCount = parts.length;
  if (entryCount <= 1) return `${icon} ${ruleName}：`;
  const keyCount = countGameViolationKeys(parts);
  const keyUnit = '期';
  const hiddenText = entryCount > shownCount ? ` / 展示${shownCount}条` : '';
  return `${icon} ${ruleName}：${entryCount}条 / ${keyCount}${keyUnit}${hiddenText}`;
}

function parseMoneyValue(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function formatNetWinLoss(p: {
  balance: string | number;
  rechargeWithdrawDiff: number;
  totalRecharge?: number;
  totalWithdraw?: number;
}): string {
  const totalRecharge = parseMoneyValue(p.totalRecharge);
  const totalWithdraw = parseMoneyValue(p.totalWithdraw);
  const balance = parseMoneyValue(p.balance);
  const hasTotals = totalRecharge !== 0 || totalWithdraw !== 0;
  const net = hasTotals
    ? totalWithdraw + balance - totalRecharge
    : balance - parseMoneyValue(p.rechargeWithdrawDiff);
  if (Math.abs(net) < 0.005) return '持平: 0';
  return `${net > 0 ? '净赢' : '净输'}: ${fmtNum(Math.abs(net))}`;
}

function hasRegistrationSignal(parts: Array<{ name?: string; reason?: string }>): boolean {
  return parts.some(part => /注册|新账号|新会员/.test(`${part.name || ''} ${part.reason || ''}`));
}

function compactGameType(gameType: string): string {
  return gameType.replace(/[、，]/g, '/').replace(/\/{2,}/g, '/');
}

function buildGameAndMethodLines(gameTypes: string | undefined, bank: string, name: string): string[] {
  const method = `${bank || '免提'}${name ? `·${name}` : ''}`;
  const compactGame = gameTypes ? compactGameType(gameTypes) : '';
  if (!compactGame) return [`🏦 提款方式: ${method}`];

  const combined = `🎮 ${compactGame}  🏦 ${method}`;
  return Array.from(combined).length <= 32
    ? [combined]
    : [`🎮 主投: ${compactGame}`, `🏦 提款方式: ${method}`];
}

export function buildRiskAlertText(p: AlertTextParams): string {
  const { icon, label, head } = LEVEL_CONFIG[p.riskLevel] || { icon: '❓', label: '未知', head: '❓' };

  const netText = formatNetWinLoss({
    balance: p.balance,
    rechargeWithdrawDiff: p.rechargeWithdrawDiff ?? 0,
    totalRecharge: p.totalRecharge,
    totalWithdraw: p.totalWithdraw,
  });
  const earlyBadge = p.isEarlyMorning ? ' · 凌晨提款' : '';

  const shortDate = p.registerTime
    ? p.registerTime.replace(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[\sT](\d{1,2}:\d{2}).*/, (_, y, m, d, t) => `${y}-${parseInt(m, 10)}-${parseInt(d, 10)} ${t}`)
    : '';

  const triggeredText = p.triggeredRules
    .map((r) => {
      const sIcon = SEVERITY_ICON[r.severity || ''] || '🟡';
      const parts = r.reason.split('\n').filter((s: string) => s.trim());
      const isBettingRule = ['R24', 'R25', 'R26'].includes(r.id);
      if (isBettingRule) {
        const ruleName = r.name || '游戏违规';
        if (parts.length <= 1) {
          return `${sIcon} ${ruleName}：${(parts[0] || r.reason).trim()}`;
        }
        const entryCount = parts.length;
        const MAX_SHOW = 8;
        const shown = parts.slice(0, MAX_SHOW);
        const header = buildGameViolationHeader(sIcon, ruleName, parts, shown.length);
        const detailLines = shown.map((s: string, idx: number) => `  ${idx + 1}. ${s.trim()}`).join('\n');
        const suffix = entryCount > MAX_SHOW ? `\n  ...还有 ${entryCount - MAX_SHOW} 条类似违规` : '';
        return `${header}\n${detailLines}${suffix}`;
      }
      if (parts.length <= 1) {
        return `${sIcon} ${r.reason}`;
      }
      return `${sIcon} ${parts.map((s: string) => s.trim()).join(' | ')}`;
    })
    .join('\n');

  const isLowRisk = p.riskLevel === 'LOW';
  const isLowLarge = isLowRisk && parseFloat(String(p.amount ?? '0')) >= 5000;
  const scorePart = isLowRisk ? (isLowLarge ? ' · 大额提款' : '') : ` ${p.totalScore}分`;
  let line1 = `${head}${label}${scorePart}${earlyBadge}`;
  let line3 = `👤 账号: ${p.memberName}  上级: ${p.proxyCode}`;
  const focusLine = `💲 提款：${fmtNum(p.amount)}  余额：${fmtNum(p.balance || 0)}  ${netText}`;
  const fundsLine = `💰 充${fmtNum(p.totalRecharge || 0)}（${p.depositCount}）/提${fmtNum(p.totalWithdraw || 0)}（${p.withdrawCount}）`;
  const registrationLine = shortDate && hasRegistrationSignal(p.triggeredRules)
    ? `📅 注册：${shortDate}`
    : '';
  const overviewLines = [
    focusLine,
    fundsLine,
    ...buildGameAndMethodLines(p.topGameTypes, p.receivingBank, p.receivingName),
    registrationLine,
  ].filter(Boolean).join('\n');
  const remark = normalizeMemberRemark(p.remark);

  const alertDetails = [
    triggeredText,
    remark ? `📝 备注：${remark}` : '',
  ].filter(Boolean).join('\n');
  let text = `${line1}\n\n${line3}\n${overviewLines}${alertDetails ? '\n\n' + alertDetails : ''}`;

  if (text.length > 4000) {
    let cutoff = 3990;
    const lastNewline = text.lastIndexOf('\n', cutoff);
    if (lastNewline > cutoff - 200) cutoff = lastNewline;
    text = safeTruncate(text, cutoff) + '\n...（更多省略）';
  }

  return formatDisplaySymbols(text);
}

export async function sendRiskAlert(evalResult: EvaluationResult, order?: WithdrawOrder): Promise<{ success: boolean; messageId?: number; text?: string }> {
  try {
    if (!bot) return { success: false };

    if (Date.now() < tgCircuitOpenUntil) {
      logger.warn('[Telegram] 断路器开启中，跳过通知');
      return { success: false };
    }

    if (!notifyChatId) {
      const now = Date.now();
      if (now - notifyChatIdLastCheck < NOTIFY_CHAT_ID_CACHE_TTL) {
        logger.warn('[Telegram] 未绑定通知群组（近期已检查），跳过通知');
        return { success: false };
      }
      notifyChatIdLastCheck = now;
      const saved = await loadChatIdFromDB();
      if (saved) notifyChatId = saved;
      else {
        logger.warn('[Telegram] 未绑定通知群组，跳过通知');
        return { success: false };
      }
    }

    const memberName = evalResult.memberName || order?.memberName || '';
    const amount = order?.amount ?? '';
    const proxyCode = evalResult.proxyCode || extractProxyCode(order);

    const text = buildRiskAlertText({
      riskLevel: evalResult.riskLevel,
      totalScore: evalResult.totalScore,
      memberName,
      proxyCode,
      balance: evalResult.balance ?? order?.balance ?? '',
      depositCount: evalResult.depositCount ?? 0,
      withdrawCount: evalResult.withdrawCount ?? 0,
      rechargeWithdrawDiff: evalResult.rechargeWithdrawDiff ?? 0,
      totalRecharge: evalResult.totalRecharge ?? 0,
      totalWithdraw: evalResult.totalWithdraw ?? 0,
      vipLevel: evalResult.vipLevel,
      sumBet: evalResult.sumBet ?? 0,
      daysSinceReg: evalResult.daysSinceReg,
      receivingBank: order?.receivingBank || '',
      receivingName: String(order?.receivingName || order?.realName || order?.memberRealName || order?.accountName || order?.bankAccountName || order?.receiving_name || ''),
      registerTime: evalResult.registerTime || '',
      amount,
      triggeredRules: evalResult.triggeredRules,
      isEarlyMorning: evalResult.isEarlyMorning,
      topGameTypes: evalResult.topGameTypes,
      remark: evalResult.remark || order?.memberRemark,
    });

    let msg: { message_id: number };
    if (evalResult.orderId) {
      msg = await bot.api.sendMessage(notifyChatId, text, { reply_markup: buildActionKeyboard(evalResult.orderId) });
    } else {
      msg = await bot.api.sendMessage(notifyChatId, text);
    }

    tgFailCount = 0;
    logger.info({ orderNo: evalResult.orderId, riskLevel: evalResult.riskLevel, score: evalResult.totalScore }, '[Telegram] ✅ 风控通知已发送');
    return { success: true, messageId: msg.message_id, text };
  } catch (err) {
    const errMsg = (err as any)?.message || '';
    // 检测永久性故障（403 Forbidden, chat not found, bot was kicked 等）
    const isPermanent = errMsg.includes('403') || errMsg.includes('chat not found') ||
      errMsg.includes('bot was kicked') || errMsg.includes('bot is not a member') ||
      errMsg.includes('PEER_ID_INVALID') || errMsg.includes('USER_DEACTIVATED');
    if (isPermanent) {
      logger.error({ err: errMsg }, '[Telegram] 检测到永久性 Telegram 错误，建议在群组中重新发送 /bind 绑定新聊天');
      // 不清除 notifyChatId，让操作员有机会手动修复
      return { success: false };
    }
    tgFailCount = Math.min(tgFailCount + 1, TG_CIRCUIT_THRESHOLD + 10);
    if (tgFailCount >= TG_CIRCUIT_THRESHOLD) {
      tgCircuitOpenUntil = Date.now() + TG_CIRCUIT_COOLDOWN;
      logger.error({ failCount: tgFailCount, cooldownSec: TG_CIRCUIT_COOLDOWN / 1000 }, `[Telegram] 连续失败 ${tgFailCount} 次，断路器开启 ${TG_CIRCUIT_COOLDOWN / 1000}s`);
    }
    logger.error({ err: errMsg }, '[Telegram] 发送通知失败');
    return { success: false };
  }
}

export async function startTelegramBot(): Promise<void> {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
      logger.error('[Telegram] 错误: 未设置 TELEGRAM_BOT_TOKEN，请检查 .env 配置');
      throw new Error('TELEGRAM_BOT_TOKEN 未配置');
    }

    bot = new Bot(token);
    bot.catch((err) => {
      logger.error({ err: (err as Error).message }, '[Telegram] Bot 处理更新时出错');
    });
    registerBotHandlers(bot);

    await initChatId();

    const me = await bot.api.getMe();
    logger.info({ username: me.username, id: me.id }, `[Telegram] Bot 启动成功: @${me.username}`);

    await bot.api.deleteWebhook({ drop_pending_updates: true });
    void bot.start({
      onStart: (info) => {
        logger.info({ username: info.username }, `[Telegram] 开始轮询更新: @${info.username}`);
      },
    }).catch((err) => {
      logger.fatal({ err: (err as Error).message }, '[Telegram] 轮询启动失败');
      process.exit(1);
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[Telegram] Bot 启动失败');
    logger.error('[Telegram] 请检查 TELEGRAM_BOT_TOKEN 是否正确');
    throw err;
  }
}

const AUTO_REVIEW_TIMEOUT_MS = 150 * 1000; // 2 分 30 秒
let isAutoReviewing = false;

/** 自动审核超过 2 分 30 秒未被人工处理的订单 */
export async function autoReviewExpiredOrders(): Promise<void> {
  if (!bot || !notifyChatId) {
    logger.warn({ hasBot: !!bot, hasChatId: !!notifyChatId }, '[Telegram] 自动审核跳过：bot或notifyChatId未就绪');
    return;
  }
  if (isAutoReviewing) return;
  isAutoReviewing = true;

  try {
    const expireAgo = Date.now() - AUTO_REVIEW_TIMEOUT_MS;
    // 查出所有已通知未审核的订单（限制24小时内，优先处理最旧的）
    const candidates = await dbHolder.db.riskEval.findMany({
      where: {
        notified: true,
        feedback: '',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    if (candidates.length > 0) {
      const expiredCount = candidates.filter(ev => {
        let detail: Record<string, any> = {};
        try { detail = JSON.parse(ev.detail || '{}'); } catch {}
        const detailNotifiedAt = typeof detail.notifiedAt === 'number' ? detail.notifiedAt : undefined;
        const notifiedAt = ev.notifiedAt ? ev.notifiedAt.getTime() : detailNotifiedAt;
        if (!notifiedAt) return false;
        return notifiedAt <= expireAgo;
      }).length;
      if (expiredCount > 0) {
        logger.info({ total: candidates.length, expired: expiredCount }, '[Telegram] 自动审核扫描 — 已通知未审核订单');
      }
    }

    for (const ev of candidates) {
      if (reviewLocks.has(ev.orderId)) continue;
      reviewLocks.add(ev.orderId);
      try {
        let triggeredRules: any[] = [];
        try { triggeredRules = JSON.parse(ev.triggeredRules || '[]'); } catch {}
        let detail: Record<string, any> = {};
        try { detail = JSON.parse(ev.detail || '{}'); } catch {}

        const detailNotifiedAt = typeof detail.notifiedAt === 'number' ? detail.notifiedAt : undefined;
        const notifiedAt = ev.notifiedAt ? ev.notifiedAt.getTime() : detailNotifiedAt;
        if (!notifiedAt || notifiedAt > expireAgo) continue;

        const notifyMsgId = ev.notifyMsgId ?? (detail.notifyMsgId as number | undefined);
        const rebuiltText = buildRiskAlertText({
          riskLevel: ev.riskLevel,
          totalScore: ev.totalScore,
          memberName: ev.memberName,
          proxyCode: (detail.proxyCode as string) || '',
          balance: (detail.balance as string | number) ?? '',
          depositCount: (detail.depositCount as number) ?? 0,
          withdrawCount: (detail.withdrawCount as number) ?? 0,
          rechargeWithdrawDiff: (detail.rechargeWithdrawDiff as number) ?? 0,
          totalRecharge: (detail.totalRecharge as number) ?? 0,
          totalWithdraw: (detail.totalWithdraw as number) ?? 0,
          vipLevel: detail.vipLevel as number | string | undefined,
          sumBet: (detail.sumBet as number) ?? 0,
          daysSinceReg: (detail.daysSinceReg as number) ?? undefined,
          receivingBank: (detail.receivingBank as string) || '',
          receivingName: (detail.receivingName as string) || '',
          registerTime: (detail.registerTime as string) || '',
          amount: (detail.orderAmount as string | number) || '',
          triggeredRules,
          isEarlyMorning: (detail.isEarlyMorning as boolean) || false,
          topGameTypes: (detail.topGameTypes as string) || undefined,
          remark: (detail.remark as string) || '',
        });

        const reviewedText = withReviewStatus(rebuiltText, '已自动审核');
        const updatedKeyboard = buildActionKeyboard(ev.orderId, true);
        let msgEdited = false;
        if (notifyMsgId && notifyChatId) {
          try {
            await bot.api.editMessageText(notifyChatId, notifyMsgId, safeTruncate(reviewedText, 4096), { reply_markup: updatedKeyboard });
            msgEdited = true;
          } catch (e1) {
            if (isTelegramMessageNotModified(e1)) {
              msgEdited = true;
              logger.info({ orderId: ev.orderId }, '[Telegram] 自动审核消息已是目标状态，跳过补发');
            } else {
              logger.warn({ orderId: ev.orderId, err: (e1 as Error).message }, '[Telegram] 自动审核编辑消息失败，尝试发新消息');
              try {
                await bot.api.sendMessage(notifyChatId, safeTruncate(reviewedText, 4096), { reply_markup: updatedKeyboard });
                msgEdited = true;
              } catch (e2) {
                logger.warn({ orderId: ev.orderId, err: (e2 as Error).message }, '[Telegram] 自动审核发送新消息也失败');
              }
            }
          }
        } else if (notifyChatId) {
          try {
            await bot.api.sendMessage(notifyChatId, safeTruncate(reviewedText, 4096), { reply_markup: updatedKeyboard });
            msgEdited = true;
          } catch (e3) {
            logger.warn({ orderId: ev.orderId, err: (e3 as Error).message }, '[Telegram] 自动审核发送消息失败（notifyMsgId缺失）');
          }
        }

        if (!msgEdited) {
          logger.warn({ orderId: ev.orderId }, '[Telegram] 自动审核消息编辑/发送均失败，保留未审核状态等待重试');
          continue;
        }

        // 只有消息处理成功后，才原子写入审核状态和违规期号去重记录。
        const recorded = await recordReviewOutcome(ev.orderId);
        if (!recorded) continue;

        logger.info({ orderId: ev.orderId, memberName: ev.memberName }, '[Telegram] 超时订单已自动审核');
      } catch (err) {
        logger.warn({ orderId: ev.orderId, err: (err as Error).message }, '[Telegram] 自动审核单条失败');
      } finally {
        reviewLocks.delete(ev.orderId);
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Telegram] 自动审核扫描失败');
  } finally {
    isAutoReviewing = false;
  }
}

export function getBot(): Bot {
  if (!bot) throw new Error('Telegram Bot 尚未初始化，请先调用 startTelegramBot()');
  return bot;
}
