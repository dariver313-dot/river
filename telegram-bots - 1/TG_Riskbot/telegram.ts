import { Bot, InlineKeyboard, type Context } from 'grammy';
import { type WithdrawOrder } from './ws-client';
import { apiClient } from './api-client';
import { invalidateMemberReviewedPeriods } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import type { BetRecord, LoginLogItem } from './types';
import { dbHolder } from './db';
import { LRUCache } from 'lru-cache';
import { logger } from './logger';
import { fmtNum, extractProxyCode, formatBeijingTime, parseTimeStr, normalizeMemberRemark } from './utils';
import { extractTwoSideDirection, expandDirections, isMutexDirection } from './rules';
import { isAgentWhitelisted } from './constants';

const LEVEL_CONFIG: Record<string, { label: string; head: string }> = {
  CRITICAL: { label: '严重风险', head: '🔴' },
  HIGH:     { label: '高风险',   head: '🟡' },
  MEDIUM:   { label: '中等风险', head: '🟡' },
  LOW:      { label: '低风险',   head: '✅' },
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

/** Telegram 将重复的 edit 视为 400；这表示目标消息已经是预期内容。 */
export function isTelegramMessageNotModified(error: unknown): boolean {
  return /message is not modified/i.test((error as Error | undefined)?.message || '');
}

const DEFAULT_ADMIN_USER_IDS = ['8373296041'];
const infoQueryLocks = new Set<string>();
const hedgeQueryLocks = new Set<string>();
// 人工审核与自动审核共用同一把锁，避免并发编辑同一条 Telegram 消息。
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getProfileLoginFetchOptions(): { maxPages: number; pageSize: number } {
  return {
    maxPages: parsePositiveInt(process.env.PROFILE_LOGIN_MAX_PAGES, 5),
    pageSize: parsePositiveInt(process.env.PROFILE_LOGIN_PAGE_SIZE, 100),
  };
}

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

async function recordFeedbackOutcome(orderId: string, feedback: 'review'): Promise<boolean> {
  let memberId = '';
  const recorded = await dbHolder.db.$transaction(async (tx) => {
    const evalRecord = await tx.riskEval.findUnique({ where: { orderId } });
    if (!evalRecord || evalRecord.feedback !== '') return false;

    const updated = await tx.riskEval.updateMany({
      where: { orderId, feedback: '' },
      data: { feedback },
    });
    if (updated.count === 0) return false;

    memberId = evalRecord.memberId || '';
    let triggeredRules: Array<{ id: string }> = [];
    try { triggeredRules = JSON.parse(evalRecord.triggeredRules || '[]'); } catch {}
    const periodInfo = (() => {
      try { return JSON.parse(evalRecord.detail || '{}').periodInfo || ''; } catch { return ''; }
    })();

    for (const rule of triggeredRules) {
      const row = {
        evalId: evalRecord.id,
        ruleId: rule.id,
        feedback,
        memberId,
        periodInfo: ['R24', 'R25', 'R26', 'R27'].includes(rule.id) ? periodInfo : '',
      };
      await tx.ruleFeedback.upsert({
        where: { evalId_ruleId: { evalId: row.evalId, ruleId: row.ruleId } },
        update: { feedback: row.feedback, memberId: row.memberId, periodInfo: row.periodInfo },
        create: row,
      });
    }
    return true;
  });

  if (recorded && memberId) invalidateMemberReviewedPeriods(memberId);
  return recorded;
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
    const ts = parseTimeStr(log.loginTime);
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
    const ts = parseTimeStr(log.loginTime);
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

async function withTimeout(label: string, timeoutMs: number, task: () => Promise<string>): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(`⏰ ${label}超时（${timeoutMs / 1000}秒），请稍后重试`);
      }
    }, timeoutMs);
    task().then((text) => {
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
  const loginLogsRes = await apiClient.getLoginLogsByMember(memberName, undefined, loginFetchOptions);
  const ownLogs = loginLogsRes?.items || [];
  const ips = sortValuesByLatestLog(ownLogs, 'loginIp', PROFILE_IP_LIMIT);
  const devices = sortValuesByLatestLog(ownLogs, 'device', PROFILE_DEVICE_LIMIT);

  try {
    const selfRes = await apiClient.getMemberInfoByName(memberName);
    const self = selfRes?.items?.[0];
    uplineName = self?.agencyMemberName || '';
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

async function buildGroupProfile(memberName: string): Promise<GroupProfile> {
  const cacheKey = memberName.trim().toLowerCase();
  const cached = groupProfileCache.get(cacheKey);
  if (cached) return cached;

  const related = new Map<string, GroupMemberHit>();
  const queuedNames = new Set<string>([cacheKey]);
  const expandedNames = new Set<string>();
  const skippedValues: string[] = [];
  const loginFetchOptions = getProfileLoginFetchOptions();
  const rootEnv = await fetchMemberEnvironment(memberName, loginFetchOptions);
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
      } catch { /* ignore single ip */ }
    }));

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
      } catch { /* ignore single device */ }
    }));
  }

  const relatedMembers = [...related.values()]
    .filter(hit => hit.memberName !== memberName)
    .sort((a, b) => b.latestLoginAt - a.latestLoginAt || b.reasons.size - a.reasons.size || a.memberName.localeCompare(b.memberName))
    .slice(0, PROFILE_MEMBER_LIMIT);

  const profile = {
    memberName,
    uplineName: rootEnv.uplineName,
    ips: rootEnv.ips,
    devices: rootEnv.devices,
    relatedMembers,
    skippedValues,
  };
  groupProfileCache.set(cacheKey, profile);
  return profile;
}

function buildGroupProfileText(profile: GroupProfile): string {
  const lines = [
    `👥 ${profile.memberName} 团体画像`,
    `上级：${profile.uplineName || '-'}`,
    `最近登录IP：${profile.ips.length ? profile.ips.join('、') : '-'}`,
    `最近登录设备：${profile.devices.length ? profile.devices.map(shortDeviceName).join('、') : '-'}`,
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
    const time = hit.latestLoginAt ? `，最近 ${formatBeijingTime(hit.latestLoginAt)}` : '';
    lines.push(`${idx + 1}. ${hit.memberName}（${reason}${time}）`);
  });
  const hidden = profile.relatedMembers.length - shown.length;
  if (hidden > 0) lines.push(`...另有 ${hidden} 个账号隐藏`);

  return lines.join('\n').slice(0, 4096);
}

function queryGroupProfile(memberName: string): Promise<string> {
  return limitHeavyTelegramQuery(() => withTimeout('团体画像查询', 25 * 1000, async () => {
    if (isAgentWhitelisted(memberName)) return `👥 ${memberName}：白名单账号，已跳过同IP/同设备深挖`;
    return buildGroupProfileText(await buildGroupProfile(memberName));
  }));
}

function sumBetAmount(bets: BetRecord[]): number {
  return bets.reduce((s, b) => s + (parseFloat(String(b.amount || 0)) || 0), 0);
}

function sumProfit(bets: BetRecord[]): number {
  return bets.reduce((s, b) => s + (parseFloat(String(b.profit || 0)) || 0), 0);
}

function queryGroupHedge(memberName: string): Promise<string> {
  return limitHeavyTelegramQuery(() => withTimeout('团体对打查询', 35 * 1000, async () => {
    if (isAgentWhitelisted(memberName)) return `🎯 ${memberName}：白名单账号，已跳过团体对打`;
    const profile = await buildGroupProfile(memberName);
    const candidateNames = [memberName, ...profile.relatedMembers.map(hit => hit.memberName)]
      .filter((name, idx, arr) => name && arr.indexOf(name) === idx)
      .filter(name => !isAgentWhitelisted(name))
      .slice(0, HEDGE_MEMBER_LIMIT);
    if (candidateNames.length < 2) return `🎯 ${memberName}：未找到可用于团体对打检测的关联账号`;

    const dateRange = apiClient.getTimezoneDateRange();
    const allBetsMap = new Map<string, BetRecord[]>();
    for (let i = 0; i < candidateNames.length; i += 5) {
      const batch = candidateNames.slice(i, i + 5);
      await Promise.all(batch.map(async (name) => {
        try {
          const res = await apiClient.getMemberBets(name, 1, dateRange, 5);
          const bets = (res?.items || []) as BetRecord[];
          if (bets.length > 0) allBetsMap.set(name, bets);
        } catch { /* ignore single member */ }
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
    const chatId = ctx.chat?.id;
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) {
      await ctx.reply('请在需要接收通知的群组中执行 /bind');
      return;
    }
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
        const recorded = await recordFeedbackOutcome(orderId, 'review');
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
  rechargeAmount?: number;
  withdrawAmount?: number;
  profitLoss?: number;
  estimatedProfitLoss?: boolean;
  receivingBank: string;
  receivingName: string;
  registerTime: string;
  amount: string | number;
  triggeredRules: Array<{
    id: string;
    name?: string;
    severity?: string;
    reason: string;
    score?: number;
    presentation?: 'core' | 'support';
  }>;
  isEarlyMorning?: boolean;
  mainGameType?: string;
  dataIssues?: string[];
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

function buildGameViolationHeader(icon: string, ruleId: string, ruleName: string, parts: string[], shownCount: number): string {
  const entryCount = parts.length;
  if (entryCount <= 1) return `${icon} ${ruleName}：`;
  const keyCount = countGameViolationKeys(parts);
  const keyUnit = ruleId === 'R27' ? '项' : '期';
  const hiddenText = entryCount > shownCount ? ` / 展示${shownCount}条` : '';
  return `${icon} ${ruleName}：${entryCount}条 / ${keyCount}${keyUnit}${hiddenText}`;
}

function formatDisplaySymbols(text: string): string {
  return text.replace(/↔/g, ' - ');
}

function parseMoneyValue(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function formatProfitLoss(value: number | undefined, estimated: boolean | undefined, balance: string | number, rechargeWithdrawDiff: number): string {
  const net = Number.isFinite(value) ? Number(value) : parseMoneyValue(balance) - parseMoneyValue(rechargeWithdrawDiff);
  const prefix = estimated ? '估算' : '';
  if (Math.abs(net) < 0.005) return `${prefix}持平: 0`;
  return `${prefix}${net > 0 ? '净赢' : '净输'}: ${fmtNum(Math.abs(net))}`;
}

function hasRegistrationSignal(parts: Array<{ name?: string; reason?: string }> | string[]): boolean {
  return parts.some(part => {
    const text = typeof part === 'string' ? part : `${part.name || ''} ${part.reason || ''}`;
    return /注册|新账号|新会员/.test(text);
  });
}

function compactGameType(gameType: string): string {
  return gameType.replace(/类游戏/g, '').replace(/[、，]/g, '/').replace(/\/{2,}/g, '/');
}

function buildGameAndMethodLines(gameType: string | undefined, bank: string, name: string): string[] {
  const method = `${bank || '未知渠道'}${name ? `·${name}` : ''}`;
  const compactGame = gameType ? compactGameType(gameType) : '';
  if (!compactGame) return [`🏦 提款方式: ${method}`];

  const combined = `🎮 ${compactGame}  🏦 ${method}`;
  return Array.from(combined).length <= 32
    ? [combined]
    : [`🎮 主投: ${compactGame}`, `🏦 提款方式: ${method}`];
}

function isCoreRule(rule: AlertTextParams['triggeredRules'][number]): boolean {
  if (rule.presentation) return rule.presentation === 'core';
  const score = Number(rule.score || 0);
  return score >= 15 || rule.severity === 'CRITICAL';
}

function formatAlertRule(rule: AlertTextParams['triggeredRules'][number]): string {
  const severityIcon = SEVERITY_ICON[rule.severity || ''] || '🟡';
  const parts = rule.reason.split('\n').filter((line: string) => line.trim());
  const isBettingRule = ['R24', 'R25', 'R26', 'R27'].includes(rule.id);
  if (isBettingRule) {
    const ruleName = rule.name || '游戏违规';
    if (parts.length <= 1) return `${severityIcon} ${ruleName}：${(parts[0] || rule.reason).trim()}`;
    const maxShow = 3;
    const shown = parts.slice(0, maxShow);
    const header = buildGameViolationHeader(severityIcon, rule.id, ruleName, parts, shown.length);
    const details = shown.map((line: string, index: number) => `  ${index + 1}. ${line.trim()}`).join('\n');
    const hidden = parts.length > maxShow ? `\n  另有 ${parts.length - maxShow} 条隐藏` : '';
    return `${header}\n${details}${hidden}`;
  }
  if (parts.length <= 1) return `${severityIcon} ${parts[0] || rule.reason}`;
  return `${severityIcon} ${parts.map((line: string) => line.trim()).join(' | ')}`;
}

export function buildRiskAlertText(p: AlertTextParams): string {
  const { label, head } = LEVEL_CONFIG[p.riskLevel] || { label: '未知', head: '❓' };

  const netText = formatProfitLoss(p.profitLoss, p.estimatedProfitLoss, p.balance, p.rechargeWithdrawDiff ?? 0);
  const manualBadge = p.triggeredRules.some((r: any) => r.id === 'R29') ? ' · 人工加款' : '';
  const earlyBadge = p.isEarlyMorning ? ' · 凌晨提款' : '';

  const shortDate = p.registerTime
    ? p.registerTime.replace(/^(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}:\d{2}).*/, (_, y, m, d, t) => `${y}-${parseInt(m, 10)}-${parseInt(d, 10)} ${t}`)
    : '';

  const sortedRules = [...p.triggeredRules].sort((a, b) => {
    const coreDiff = Number(isCoreRule(b)) - Number(isCoreRule(a));
    if (coreDiff !== 0) return coreDiff;
    const scoreA = Number((a as { score?: number }).score || 0);
    const scoreB = Number((b as { score?: number }).score || 0);
    return scoreB - scoreA;
  });
  const triggeredText = sortedRules.map(formatAlertRule).join('\n');

  let line1 = `${head}${label} ${p.totalScore}分${manualBadge}${earlyBadge}`;
  let line3 = `👤 账号: ${p.memberName}  上级: ${p.proxyCode}`;
  const focusLine = `💲 提款：${fmtNum(p.amount)}  余额：${fmtNum(p.balance || 0)}  ${netText}`;
  const fundsLine = `💰 充${fmtNum(p.rechargeAmount || 0)}（${p.depositCount}）/提${fmtNum(p.withdrawAmount || 0)}（${p.withdrawCount}）`;
  const registrationLine = shortDate && hasRegistrationSignal(p.triggeredRules)
    ? `📅 注册：${shortDate}`
    : '';
  const overviewLines = [
    focusLine,
    fundsLine,
    ...buildGameAndMethodLines(p.mainGameType, p.receivingBank, p.receivingName),
    registrationLine,
  ].filter(Boolean).join('\n');
  const remark = normalizeMemberRemark(p.remark);

  const dataStatus = (p.dataIssues?.length || 0) > 0
    ? `数据不完整：${p.dataIssues!.slice(0, 3).join('、')}，需人工复核`
    : '';
  const alertDetails = [
    triggeredText,
    dataStatus,
    remark ? `📝 备注：${remark}` : '',
  ].filter(Boolean).join('\n');
  let text = `${line1}\n\n${line3}\n${overviewLines}${alertDetails ? '\n\n' + alertDetails : ''}`;

  if (text.length > 4000) {
    let cutoff = 3990;
    const lastNewline = text.lastIndexOf('\n', cutoff);
    if (lastNewline > cutoff - 200) cutoff = lastNewline;
    text = text.substring(0, cutoff) + '\n...（更多省略）';
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

    if (evalResult.riskLevel === 'LOW') {
      const numAmount = parseFloat(String(amount ?? '0'));
      const isLargeLow = numAmount >= 5000;
      const lowText = buildLowAmountAlertText({
        memberName,
        proxyCode,
        balance: evalResult.balance ?? order?.balance ?? 0,
        depositCount: evalResult.depositCount ?? 0,
        withdrawCount: evalResult.withdrawCount ?? 0,
        rechargeWithdrawDiff: evalResult.rechargeWithdrawDiff ?? 0,
        rechargeAmount: evalResult.rechargeAmount ?? 0,
        withdrawAmount: evalResult.withdrawAmount ?? 0,
        profitLoss: evalResult.profitLoss,
        estimatedProfitLoss: evalResult.estimatedProfitLoss,
        receivingBank: order?.receivingBank || '',
        receivingName: String(order?.receivingName || order?.realName || order?.memberRealName || order?.accountName || order?.bankAccountName || order?.receiving_name || ''),
        registerTime: evalResult.registerTime || '',
        amount,
        isLarge: isLargeLow,
        mainGameType: evalResult.mainGameType,
        remark: evalResult.remark || order?.memberRemark,
        auxiliaryReasons: evalResult.triggeredRules.slice(0, 3).map(rule => rule.reason),
      });

      if (evalResult.orderId) {
        const msg = await bot.api.sendMessage(notifyChatId, lowText, { reply_markup: buildActionKeyboard(evalResult.orderId) });
        tgFailCount = 0;
        logger.info({ orderNo: evalResult.orderId, amount: numAmount }, '[Telegram] ✅ 低风险通知已发送（带审核按钮）');
        return { success: true, messageId: msg.message_id, text: lowText };
      }

      const msg = await bot.api.sendMessage(notifyChatId, lowText);
      tgFailCount = 0;
      logger.info({ orderNo: evalResult.orderId, riskLevel: evalResult.riskLevel }, '[Telegram] ✅ 低风险通知已发送');
      return { success: true, messageId: msg.message_id, text: lowText };
    }

    const text = buildRiskAlertText({
      riskLevel: evalResult.riskLevel,
      totalScore: evalResult.totalScore,
      memberName,
      proxyCode,
      balance: evalResult.balance ?? order?.balance ?? '',
      depositCount: evalResult.depositCount ?? 0,
      withdrawCount: evalResult.withdrawCount ?? 0,
      rechargeWithdrawDiff: evalResult.rechargeWithdrawDiff ?? 0,
      rechargeAmount: evalResult.rechargeAmount ?? 0,
      withdrawAmount: evalResult.withdrawAmount ?? 0,
      profitLoss: evalResult.profitLoss,
      estimatedProfitLoss: evalResult.estimatedProfitLoss,
      receivingBank: order?.receivingBank || '',
      receivingName: String(order?.receivingName || order?.realName || order?.memberRealName || order?.accountName || order?.bankAccountName || order?.receiving_name || ''),
      registerTime: evalResult.registerTime || '',
      amount,
      triggeredRules: evalResult.triggeredRules,
      isEarlyMorning: evalResult.isEarlyMorning,
      mainGameType: evalResult.mainGameType,
      dataIssues: evalResult.dataIssues,
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
    tgFailCount++;
    if (tgFailCount >= TG_CIRCUIT_THRESHOLD) {
      tgCircuitOpenUntil = Date.now() + TG_CIRCUIT_COOLDOWN;
      logger.error({ failCount: tgFailCount, cooldownSec: TG_CIRCUIT_COOLDOWN / 1000 }, `[Telegram] 连续失败 ${tgFailCount} 次，断路器开启 ${TG_CIRCUIT_COOLDOWN / 1000}s`);
    }
    logger.error({ err: (err as Error).message }, '[Telegram] 发送通知失败');
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
    bot.start({
      onStart: (info) => {
        logger.info({ username: info.username }, `[Telegram] 开始轮询更新: @${info.username}`);
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[Telegram] Bot 启动失败');
    logger.error('[Telegram] 请检查 TELEGRAM_BOT_TOKEN 是否正确');
    throw err;
  }
}

const AUTO_REVIEW_TIMEOUT_MS = 150 * 1000; // 2 分 30 秒

/** 构建低风险提款通知文本（sendRiskAlert 和 autoReview 共用） */
export function buildLowAmountAlertText(p: {
  memberName: string;
  proxyCode: string;
  balance: string | number;
  depositCount: number;
  withdrawCount: number;
  rechargeWithdrawDiff: number;
  rechargeAmount: number;
  withdrawAmount: number;
  profitLoss?: number;
  estimatedProfitLoss?: boolean;
  receivingBank: string;
  receivingName: string;
  registerTime: string;
  amount: string | number;
  isLarge?: boolean;
  mainGameType?: string;
  remark?: string;
  auxiliaryReasons?: string[];
}): string {
  const netText = formatProfitLoss(p.profitLoss, p.estimatedProfitLoss, p.balance, p.rechargeWithdrawDiff ?? 0);
  const shortDate = p.registerTime
    ? p.registerTime.replace(/^(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}:\d{2}).*/, (_, y: string, m: string, d: string, t: string) => `${y}-${parseInt(m, 10)}-${parseInt(d, 10)} ${t}`)
    : '';
  const hasRegistrationRelatedReason = hasRegistrationSignal(p.auxiliaryReasons || []);
  const lines = [
    p.isLarge ? `✅ 低风险 · 大额提款` : `✅ 低风险`,
    '',
    `👤 账号: ${p.memberName}  上级: ${p.proxyCode}`,
    `💲 提款：${fmtNum(p.amount)}  余额：${fmtNum(p.balance || 0)}  ${netText}`,
    `💰 充${fmtNum(p.rechargeAmount)}（${p.depositCount}）/提${fmtNum(p.withdrawAmount)}（${p.withdrawCount}）`,
    ...buildGameAndMethodLines(p.mainGameType, p.receivingBank, p.receivingName),
  ];
  if (shortDate && hasRegistrationRelatedReason) lines.push(`📅 注册：${shortDate}`);
  const hasAuxiliaryReasons = (p.auxiliaryReasons?.length || 0) > 0;
  if (hasAuxiliaryReasons) {
    lines.push('', ...p.auxiliaryReasons!.map(reason => `🟡 ${reason.split('\n')[0]}`));
  }
  const remark = normalizeMemberRemark(p.remark);
  if (remark) {
    if (!hasAuxiliaryReasons) lines.push('');
    lines.push(`📝 备注：${remark}`);
  }
  return lines.join('\n');
}

/** 精准定时：通知发送成功后调用，2分30秒后准时触发自动审核（setTimeout，非轮询）。
 *  进程重启后定时器丢失，由 autoReviewExpiredOrders 兜底扫描补处理。 */
export function scheduleAutoReview(orderId: string): void {
  setTimeout(async () => {
    await tryAutoReviewSingleOrder(orderId);
  }, AUTO_REVIEW_TIMEOUT_MS);
}

/** 精准定时自动审核的单条入口：查 DB 后调公共处理函数 */
async function tryAutoReviewSingleOrder(orderId: string): Promise<void> {
  if (!bot || !notifyChatId) return;

  try {
    const ev = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
    if (!ev) return;
    await autoReviewOneRecord(ev);
  } catch (err) {
    logger.warn({ orderId, err: (err as Error).message }, '[Telegram] 精准定时自动审核失败');
  }
}

/** 对单条 RiskEval 记录执行自动审核（先更新/补发消息，再落库反馈）。
 *  由 tryAutoReviewSingleOrder（精准 setTimeout）和 autoReviewExpiredOrders（批量兜底）共用。
 *  所有条件判断（超时、CAS、按钮检测）均在此函数内完成，调用方只需传入记录。 */
async function autoReviewOneRecord(ev: {
  id: string;
  orderId: string;
  memberId: string;
  memberName: string;
  totalScore: number;
  riskLevel: string;
  triggeredRules: string;
  detail: string;
  feedback: string;
  notified: boolean;
  notifyMsgId: number | null;
  notifiedAt: Date | null;
  createdAt: Date;
}): Promise<void> {
  const orderId = ev.orderId;
  if (reviewLocks.has(orderId)) return;
  reviewLocks.add(orderId);

  try {
    // 两条自动审核路径可能同时命中同一订单，锁住后再从数据库读取最新状态。
    const current = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
    if (!current) return;
    ev = current;

  // 已审核或未通知的订单跳过
  if (ev.feedback !== '') return;
  if (!ev.notified) return;
  if (!bot || !notifyChatId) return;

  let triggeredRules: any[] = [];
  try { triggeredRules = JSON.parse(ev.triggeredRules || '[]'); } catch {}

  let detail: Record<string, any> = {};
  try { detail = JSON.parse(ev.detail || '{}'); } catch {}

  const orderAmount = parseFloat(String(detail.orderAmount ?? '0'));
  const isLowAutoReview = ev.riskLevel === 'LOW';

  // 精确超时判断：专用列 notifiedAt，回退到 createdAt（兼容旧数据）
  const effectiveNotifiedAt = ev.notifiedAt ? ev.notifiedAt.getTime() : new Date(ev.createdAt).getTime();
  if (Date.now() - effectiveNotifiedAt < AUTO_REVIEW_TIMEOUT_MS) return;

  // 更新 Telegram 消息：保留查询按钮，并追加系统自动处理状态。
  const notifyMsgId = ev.notifyMsgId;
  let rebuiltText: string;
  if (isLowAutoReview) {
    rebuiltText = buildLowAmountAlertText({
      memberName: ev.memberName,
      proxyCode: (detail.proxyCode as string) || '',
      balance: (detail.balance as string | number) || '',
      depositCount: (detail.depositCount as number) ?? 0,
      withdrawCount: (detail.withdrawCount as number) ?? 0,
      rechargeWithdrawDiff: (detail.rechargeWithdrawDiff as number) ?? 0,
      rechargeAmount: (detail.rechargeAmount as number) ?? 0,
      withdrawAmount: (detail.withdrawAmount as number) ?? 0,
      profitLoss: detail.profitLoss as number | undefined,
      estimatedProfitLoss: (detail.estimatedProfitLoss as boolean) ?? true,
      receivingBank: (detail.receivingBank as string) || '',
      receivingName: (detail.receivingName as string) || '',
      registerTime: (detail.registerTime as string) || '',
      amount: (detail.orderAmount as string | number) || '',
      isLarge: orderAmount >= 5000,
      mainGameType: (detail.mainGameType as string) || undefined,
      remark: (detail.remark as string) || '',
      auxiliaryReasons: triggeredRules.slice(0, 3).map((rule: any) => String(rule.reason || '')),
    });
  } else {
    rebuiltText = buildRiskAlertText({
      riskLevel: ev.riskLevel,
      totalScore: ev.totalScore,
      memberName: ev.memberName,
      proxyCode: (detail.proxyCode as string) || '',
      balance: (detail.balance as string | number) || '',
      depositCount: (detail.depositCount as number) ?? 0,
      withdrawCount: (detail.withdrawCount as number) ?? 0,
      rechargeWithdrawDiff: (detail.rechargeWithdrawDiff as number) ?? 0,
      rechargeAmount: (detail.rechargeAmount as number) ?? 0,
      withdrawAmount: (detail.withdrawAmount as number) ?? 0,
      profitLoss: detail.profitLoss as number | undefined,
      estimatedProfitLoss: (detail.estimatedProfitLoss as boolean) ?? true,
      receivingBank: (detail.receivingBank as string) || '',
      receivingName: (detail.receivingName as string) || '',
      registerTime: (detail.registerTime as string) || '',
      amount: (detail.orderAmount as string | number) || '',
      triggeredRules,
      isEarlyMorning: (detail.isEarlyMorning as boolean) || false,
      mainGameType: (detail.mainGameType as string) || undefined,
      dataIssues: (detail.dataIssues as string[]) || [],
      remark: (detail.remark as string) || '',
    });
  }

  const reviewedText = withReviewStatus(rebuiltText, '已自动审核');
  const updatedKeyboard = buildActionKeyboard(ev.orderId, true);

  let msgEdited = false;
  if (notifyMsgId && notifyChatId) {
    try {
      await bot.api.editMessageText(notifyChatId, notifyMsgId, reviewedText.substring(0, 4096), { reply_markup: updatedKeyboard });
      msgEdited = true;
    } catch (editErr) {
      if (isTelegramMessageNotModified(editErr)) {
        // 另一条审核路径已完成编辑；无需再发一条通知。
        msgEdited = true;
        logger.info({ orderId: ev.orderId }, '[Telegram] 自动审核消息已是目标状态，跳过补发');
      } else {
        logger.warn({ orderId: ev.orderId, err: (editErr as Error).message }, '[Telegram] 自动审核编辑消息失败，尝试发新消息');
        try {
          await bot.api.sendMessage(notifyChatId, reviewedText.substring(0, 4096), { reply_markup: updatedKeyboard });
          msgEdited = true;
        } catch (sendErr) {
          logger.warn({ orderId: ev.orderId, err: (sendErr as Error).message }, '[Telegram] 自动审核发新消息也失败');
        }
      }
    }
  } else if (notifyChatId) {
    logger.info({ orderId: ev.orderId }, '[Telegram] 自动审核 notifyMsgId 缺失，发新消息');
    try {
      await bot.api.sendMessage(notifyChatId, reviewedText.substring(0, 4096), { reply_markup: updatedKeyboard });
      msgEdited = true;
    } catch (sendErr) {
      logger.warn({ orderId: ev.orderId, err: (sendErr as Error).message }, '[Telegram] 自动审核发新消息失败');
    }
  }

  if (!msgEdited) {
    logger.warn({ orderId: ev.orderId }, '[Telegram] 自动审核消息编辑/发送均失败，保留未审核状态等待重试');
    return;
  }

  // 风险单和逐规则反馈在同一事务中落库，避免只更新一半后无法重试。
  const recorded = await recordFeedbackOutcome(ev.orderId, 'review');
  if (!recorded) return;

  logger.info({ orderId: ev.orderId, memberName: ev.memberName, riskLevel: ev.riskLevel }, '[Telegram] 超时订单已自动审核');
  } finally {
    reviewLocks.delete(orderId);
  }
}

/** 批量兜底：定时扫描超时未审核订单（进程重启后 setTimeout 丢失的补偿机制） */
export async function autoReviewExpiredOrders(): Promise<void> {
  if (!bot || !notifyChatId) return;

  try {
    const preFilterAgo = new Date(Date.now() - AUTO_REVIEW_TIMEOUT_MS);

    // Query 1: 非 LOW 且有触发规则的订单（投注违规 R24-R27）
    const bettingCandidates = await dbHolder.db.riskEval.findMany({
      where: {
        notified: true,
        feedback: '',
        riskLevel: { not: 'LOW' },
        createdAt: { lt: preFilterAgo },
        triggeredRules: { not: '[]' },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    // Query 2: LOW 风险订单（现在统一带审核按钮）
    const lowCandidates = await dbHolder.db.riskEval.findMany({
      where: {
        notified: true,
        feedback: '',
        createdAt: { lt: preFilterAgo },
        riskLevel: 'LOW',
      },
      take: 20,
      orderBy: { createdAt: 'asc' },
    });

    // 合并去重
    const seen = new Set<string>();
    const candidates = [...bettingCandidates];
    for (const ev of lowCandidates) {
      if (!seen.has(ev.id)) {
        candidates.push(ev);
        seen.add(ev.id);
      }
    }

    for (const ev of candidates) {
      try {
        await autoReviewOneRecord(ev);
      } catch (err) {
        logger.warn({ orderId: ev.orderId, err: (err as Error).message }, '[Telegram] 批量自动审核单条失败');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Telegram] 批量自动审核扫描失败');
  }
}

export function getBot(): Bot {
  if (!bot) throw new Error('Telegram Bot 尚未初始化，请先调用 startTelegramBot()');
  return bot;
}
