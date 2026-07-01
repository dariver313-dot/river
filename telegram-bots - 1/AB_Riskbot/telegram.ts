import { Bot, InlineKeyboard } from 'grammy';
import type { WithdrawOrder } from './types';
import { apiClient } from './api-client';
import { getAllRules, setRuleEnabled, getRuleStates, invalidateMemberReviewedPeriods } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import { dbHolder } from './db';
import { LRUCache } from 'lru-cache';
import { getMemberProfileText, ipMemberCache, deviceMemberCache, memberLoginLogsCache } from './evaluator';
import { logger } from './logger';
import { fmtNum, extractProxyCode, formatBeijingTime } from './utils';
import { extractTwoSideDirection, expandDirections, isMutexDirection } from './rules';
import { AGENT_WHITELIST } from './constants';

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

function safeTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  // 仅在需要截断时才展开 Unicode 字符，避免不必要的 Array.from 分配
  const chars = [...str];
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen).join('');
}

const lastActionTime = new LRUCache<number, number>({ max: 10000, ttl: 24 * 3600000 });
const RATE_LIMIT_MS = 1500;
const infoQueryLocks = new Set<string>();
const hedgeQueryLocks = new Set<string>();

// 返回 true 表示允许执行（未触发限速），false 表示被限速或无效用户
function checkRateLimit(userId: number | undefined): boolean {
  if (!userId || userId <= 0) return false;
  const now = Date.now();
  const last = lastActionTime.get(userId) || 0;
  if (now - last < RATE_LIMIT_MS) return false;
  lastActionTime.set(userId, now);
  return true;
}

async function querySubordinateHedge(memberName: string): Promise<string> {
  const HEDGE_TIMEOUT = 25 * 1000;

  const doQuery = async (): Promise<string> => {
    if (AGENT_WHITELIST.has(memberName)) {
      return `🎯 ${memberName}：白名单代理，无需检查`;
    }

    // 从 API 获取会员自身信息，取上级代理
    let uplineName = '';
    try {
      const selfRes = await apiClient.getMemberInfoByName(memberName);
      const selfItems = selfRes?.items || [];
      uplineName = selfItems[0]?.agencyMemberName || '';
    } catch { /* 获取上级失败不影响主流程 */ }

    // 获取下级会员
    let subMembers: any[] = [];
    let subPage = 1;
    const SUB_NEED = 10;
    while (subPage <= 3) {
      const subRes = await apiClient.getMembersByAgency(memberName, subPage, 200);
      const batch = subRes?.items || (Array.isArray(subRes?.data) ? subRes.data : []) || [];
      subMembers.push(...batch);
      if (batch.length < 200 || subMembers.length >= SUB_NEED) break;
      subPage++;
    }

    const subNames = subMembers
      .map((m: any) => m.memberName || m.userName || '')
      .filter((n: string) => n && n !== memberName)
      .slice(0, 10) as string[]; // 上限10人，防止API调用过多

    const dateRange = apiClient.getTimezoneDateRange();

    // 构建查询名单：自身 + 下级 + 上级（非白名单）
    const checkUpline = uplineName && uplineName !== memberName && !AGENT_WHITELIST.has(uplineName);
    const allNames = [memberName, ...subNames];
    if (checkUpline) allNames.push(uplineName);

    const HEDGE_BATCH = 5;
    const allBetsMap = new Map<string, any[]>();

    for (let bi = 0; bi < allNames.length; bi += HEDGE_BATCH) {
      const batch = allNames.slice(bi, bi + HEDGE_BATCH);
      await Promise.all(batch.map(async (name) => {
        try {
          const betsRes: any = await apiClient.getMemberBetsToday(name, 1, dateRange, 5);
          const bets = betsRes?.items || betsRes?.data?.items || betsRes?.list || (Array.isArray(betsRes?.data) ? betsRes.data : []) || [];
          if (bets.length > 0) allBetsMap.set(name, bets);
        } catch {}
      }));
    }

    // 既无下级也无上级可查
    if (subNames.length === 0 && !checkUpline) {
      return `🎯 ${memberName}：无下级会员，无需检查`;
    }

    const myBets = allBetsMap.get(memberName) || [];
    if (myBets.length === 0) {
      const subInfo = subNames.length > 0 ? `（${subNames.length}个下级）` : '';
      const uplineInfo = checkUpline ? ` 上级:${uplineName}` : '';
      return `🎯 ${memberName}${subInfo}${uplineInfo}：今日无投注记录`;
    }

    if (allBetsMap.size === 1 && subNames.length > 0) {
      return `🎯 ${memberName}（${subNames.length}个下级）：仅自身有投注，下级均无投注记录`;
    }

    const myIssueMap = new Map<string, any[]>();
    for (const bet of myBets) {
      const key = `${bet.lotteryName} ${bet.issue}`;
      if (!myIssueMap.has(key)) myIssueMap.set(key, []);
      myIssueMap.get(key)!.push(bet);
    }

    const hedgeResults: string[] = [];

    // 检查会员与下级之间的对打对冲
    for (const subName of subNames) {
      const subBets = allBetsMap.get(subName) || [];
      if (subBets.length === 0) continue;

      const subIssueMap = new Map<string, any[]>();
      for (const bet of subBets) {
        const key = `${bet.lotteryName} ${bet.issue}`;
        if (!subIssueMap.has(key)) subIssueMap.set(key, []);
        subIssueMap.get(key)!.push(bet);
      }

      let hedgeCount = 0;
      let hedgeDetails: string[] = [];

      for (const [issueKey, myIssueBets] of myIssueMap) {
        const subIssueBets = subIssueMap.get(issueKey);
        if (!subIssueBets) continue;

        const myDirections = new Set(myIssueBets.flatMap(b => expandDirections(extractTwoSideDirection(b.numbers))));
        const subDirections = new Set(subIssueBets.flatMap(b => expandDirections(extractTwoSideDirection(b.numbers))));

        let isOpposite = false;
        for (const d1 of myDirections) {
          for (const d2 of subDirections) {
            if (isMutexDirection(d1, d2)) {
              isOpposite = true;
              break;
            }
          }
          if (isOpposite) break;
        }

        const myPlays = new Set(myIssueBets.map(b => b.playClassName).filter(Boolean));
        const subPlays = new Set(subIssueBets.map(b => b.playClassName).filter(Boolean));
        const isHedge = myPlays.size > 0 && subPlays.size > 0 && [...myPlays].some(p => subPlays.has(p)) &&
          myIssueBets.length + subIssueBets.length > 5;

        if (isOpposite || isHedge) {
          hedgeCount++;
          if (hedgeDetails.length < 3) {
            const myAmt = myIssueBets.reduce((s: number, b: any) => s + (parseFloat(b.amount) || 0), 0);
            const subAmt = subIssueBets.reduce((s: number, b: any) => s + (parseFloat(b.amount) || 0), 0);
            const tag = isOpposite ? '对打' : '对冲';
            hedgeDetails.push(`${issueKey} ${tag} ${memberName} ${myAmt.toFixed(0)} vs ${subName} ${subAmt.toFixed(0)}`);
          }
        }
      }

      if (hedgeCount > 0) {
        let line = `🔴 ${subName}：${hedgeCount}期对打/对冲`;
        if (hedgeDetails.length > 0) line += '\n  ' + hedgeDetails.join('\n  ');
        if (hedgeCount > 3) line += `\n  ...及其他${hedgeCount - 3}期`;
        hedgeResults.push(line);
      }
    }

    // 检查会员与上级之间的对打对冲
    if (checkUpline) {
      const uplineBets = allBetsMap.get(uplineName) || [];
      if (uplineBets.length > 0) {
        const uplineIssueMap = new Map<string, any[]>();
        for (const bet of uplineBets) {
          const key = `${bet.lotteryName} ${bet.issue}`;
          if (!uplineIssueMap.has(key)) uplineIssueMap.set(key, []);
          uplineIssueMap.get(key)!.push(bet);
        }

        let upHedgeCount = 0;
        let upHedgeDetails: string[] = [];
        for (const [issueKey, myIssueBets] of myIssueMap) {
          const upIssueBets = uplineIssueMap.get(issueKey);
          if (!upIssueBets) continue;

          const myDirections = new Set(myIssueBets.flatMap(b => expandDirections(extractTwoSideDirection(b.numbers))));
          const upDirections = new Set(upIssueBets.flatMap(b => expandDirections(extractTwoSideDirection(b.numbers))));

          let isOpposite = false;
          for (const d1 of myDirections) {
            for (const d2 of upDirections) {
              if (isMutexDirection(d1, d2)) { isOpposite = true; break; }
            }
            if (isOpposite) break;
          }

          const myPlays = new Set(myIssueBets.map(b => b.playClassName).filter(Boolean));
          const upPlays = new Set(upIssueBets.map(b => b.playClassName).filter(Boolean));
          const isHedge = myPlays.size > 0 && upPlays.size > 0 && [...myPlays].some(p => upPlays.has(p)) &&
            myIssueBets.length + upIssueBets.length > 5;

          if (isOpposite || isHedge) {
            upHedgeCount++;
            if (upHedgeDetails.length < 3) {
              const myAmt = myIssueBets.reduce((s: number, b: any) => s + (parseFloat(b.amount) || 0), 0);
              const upAmt = upIssueBets.reduce((s: number, b: any) => s + (parseFloat(b.amount) || 0), 0);
              const tag = isOpposite ? '对打' : '对冲';
              upHedgeDetails.push(`${issueKey} ${tag} ${memberName} ${myAmt.toFixed(0)} vs ${uplineName} ${upAmt.toFixed(0)}`);
            }
          }
        }

        if (upHedgeCount > 0) {
          let line = `🟠 上级 ${uplineName}：${upHedgeCount}期对打/对冲`;
          if (upHedgeDetails.length > 0) line += '\n  ' + upHedgeDetails.join('\n  ');
          if (upHedgeCount > 3) line += `\n  ...及其他${upHedgeCount - 3}期`;
          hedgeResults.unshift(line);
        }
      }
    }

    // 构建结果文本
    const uplineLabel = uplineName ? ` 上级:${uplineName}` : '';
    let prefix = `🎯 ${memberName}`;
    if (subNames.length > 0) {
      prefix += `（${subNames.length}个下级${uplineLabel}）`;
    } else if (uplineName) {
      prefix += `（上级:${uplineName}）`;
    }

    if (hedgeResults.length === 0) {
      if (subNames.length === 0 && checkUpline) {
        return `${prefix}：✅ 与上级未发现对打对冲行为`;
      }
      return `${prefix}：✅ 未发现对打对冲行为`;
    }

    return `${prefix}对打对冲检测结果：\n${hedgeResults.join('\n')}`;
  };

  return new Promise<string>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(`⏰ 查询超时（${HEDGE_TIMEOUT / 1000}秒），请稍后重试`); }
    }, HEDGE_TIMEOUT);
    doQuery().then((text) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(text); }
    }).catch((err) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(`❌ 查询失败: ${err.message}`); }
    });
  });
}

function queryMemberAssociation(memberName: string): Promise<string> {
  const QUERY_TIMEOUT = 15 * 1000;

  const doQuery = async (): Promise<string> => {
    let ips: string[];
    let devices: string[];
    const cachedLogs = memberLoginLogsCache.get(memberName);
    if (cachedLogs) {
      ips = cachedLogs.ips;
      devices = cachedLogs.devices;
    } else {
      const loginLogsRes = await apiClient.getLoginLogsByMember(memberName);
      const logs = loginLogsRes?.items || [];
      if (logs.length === 0) return `📋 ${memberName}：未找到登录记录`;
      ips = [...new Set(logs.map((l: any) => l.loginIp).filter(Boolean))].slice(0, 5) as string[];
      devices = [...new Set(logs.map((l: any) => l.device).filter(Boolean))].slice(0, 5) as string[];
      memberLoginLogsCache.set(memberName, { ips, devices });
    }

    if (ips.length === 0 && devices.length === 0) {
      return `📋 ${memberName}：无登录IP/设备记录`;
    }

    const now = Date.now();
    const ipPromises = ips.map((ip) => {
      const cached = ipMemberCache.get(ip);
      if (cached) {
        const names = [...cached.members].filter(n => n && n !== memberName);
        return Promise.resolve({ ip, names, total: names.length });
      }
      return apiClient.getLoginLogsByIp(ip).then((res: any) => {
        const items = res?.items || [];
        const names = [...new Set(items.map((l: any) => l.memberName).filter((n: string) => n && n !== memberName))];
        const members = new Set<string>(items.map((l: any) => l.memberName).filter(Boolean));
        ipMemberCache.set(ip, { members });
        return { ip, names, total: parseInt(res?.totalNum || '0', 10) };
      }).catch(() => ({ ip, names: [] as string[], total: 0 }));
    });

    const devicePromises = devices.map((device) => {
      const cached = deviceMemberCache.get(device);
      if (cached) {
        const names = [...cached.members].filter(n => n && n !== memberName);
        return Promise.resolve({ device, names, total: names.length });
      }
      return apiClient.getLoginLogsByDevice(device).then((res: any) => {
        const items = res?.items || [];
        const names = [...new Set(items.map((l: any) => l.memberName).filter((n: string) => n && n !== memberName))];
        const members = new Set<string>(items.map((l: any) => l.memberName).filter(Boolean));
        deviceMemberCache.set(device, { members });
        return { device, names, total: parseInt(res?.totalNum || '0', 10) };
      }).catch(() => ({ device, names: [] as string[], total: 0 }));
    });

    const [ipResults, deviceResults] = await Promise.all([
      Promise.all(ipPromises),
      Promise.all(devicePromises),
    ]);

    let assocText = '';

    const ipWithOthers = ipResults.filter(r => (r.names as string[]).length > 0);
    if (ipWithOthers.length > 0) {
      assocText += '\n🌐 同IP会员：';
      for (const r of ipWithOthers) {
        const names = (r.names as string[]).slice(0, 10).join('、');
        assocText += `\n  ${r.ip}：${names}`;
      }
    }

    const devWithOthers = deviceResults.filter(r => (r.names as string[]).length > 0);
    if (devWithOthers.length > 0) {
      assocText += '\n📱 同设备会员：';
      for (const r of devWithOthers) {
        const shortDevice = (r.device as string).split(':')[0] || r.device;
        const names = (r.names as string[]).slice(0, 10).join('、');
        assocText += `\n  ${shortDevice}：${names}`;
      }
    }

    if (!assocText) {
      assocText = '\n✅ 未发现同IP/同设备关联会员';
    }

    return `📋 ${memberName} 关联查询结果${assocText}`;
  };

  return new Promise<string>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(`⏰ 查询超时（${QUERY_TIMEOUT / 1000}秒），请稍后重试`); }
    }, QUERY_TIMEOUT);
    doQuery().then((text) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(text); }
    }).catch((err) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(`❌ 查询失败: ${err.message}`); }
    });
  });
}

function registerBotHandlers(b: Bot): void {
  b.command('bind', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId) {
      notifyChatId = chatId;
      await saveChatIdToDB(chatId);
      await ctx.reply('✅ 已绑定');
    }
  });

  b.command('rules', async (ctx) => {
    if (!checkRateLimit(ctx.from?.id || 0)) return;

    const rules = getAllRules();
    const groups: Record<string, typeof rules> = {};
    for (const r of rules) {
      if (!groups[r.group]) groups[r.group] = [];
      groups[r.group].push(r);
    }

    const groupNames: Record<string, string> = {
      identity: '👤 身份风险',
      association: '🔗 关联风险',
      behavior: '💰 行为风险',
      environment: '🌐 环境风险',
      marking: '🏷️ 标记风险',
    };

    let text = `📋 风控规则列表 (共 ${rules.length} 条)\n\n`;

    for (const [groupKey, groupRules] of Object.entries(groups)) {
      text += `${groupNames[groupKey] || groupKey}\n`;
      for (const r of groupRules) {
        const icon = r.severity === 'CRITICAL' ? '🔴' : r.severity === 'HIGH' ? '🟠' : '🟡';
        const status = r.enabled ? '' : ' [已关闭]';
        text += `  ${icon} ${r.id} ${r.name}${status}\n`;
      }
      text += '\n';
    }

    text += `\n💡 /rule R01 off — 关闭规则\n/rule R01 on — 开启规则`;

    await ctx.reply(text);
  });

  b.command('rule', async (ctx) => {
    if (!checkRateLimit(ctx.from?.id || 0)) return;

    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    if (parts.length < 3) {
      await ctx.reply(`用法: /rule <规则ID> <on|off>\n\n例如: /rule R01 off\n/rule R01 on`);
      return;
    }

    const ruleId = parts[1].toUpperCase();
    const action = parts[2].toLowerCase();

    if (action !== 'on' && action !== 'off') {
      await ctx.reply(`❌ 无效操作: ${parts[2]}\n请使用 on 或 off`);
      return;
    }

    const enabled = action === 'on';
    const ok = setRuleEnabled(ruleId, enabled);

    if (ok) {
      try {
        await dbHolder.db.botConfig.upsert({
          where: { key: 'RULE_STATES' },
          update: { value: JSON.stringify(getRuleStates()) },
          create: { key: 'RULE_STATES', value: JSON.stringify(getRuleStates()) },
        });
      } catch {}
    }

    if (ok) {
      await ctx.reply(`✅ 规则 ${ruleId} 已${enabled ? '开启' : '关闭'}`);
    } else {
      await ctx.reply(`❌ 未找到规则: ${ruleId}\n\n使用 /rules 查看所有规则`);
    }
  });

  b.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 风控提醒机器人 使用指南\n\n` +
      `📌 **可用命令**:\n` +
      `/status - 查看机器人运行状态\n` +
      `/rules - 查看风控规则列表\n` +
      `/rule R01 off - 关闭指定规则\n` +
      `/rule R01 on - 开启指定规则\n` +
      `/help - 显示此帮助信息`,
    );
  });

  b.callbackQuery(/^feedback:(.+):(review|info|hedge)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const action = ctx.match[2];

    if (action === 'info') {
      if (infoQueryLocks.has(orderId)) {
        await ctx.answerCallbackQuery({ text: '查询进行中，请稍候...' });
        return;
      }
      infoQueryLocks.add(orderId);
      try {
        await ctx.answerCallbackQuery({ text: '正在查询关联信息...' });
        try {
          const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
          const memberName = evalRecord?.memberName || '';
          if (!memberName) {
            await ctx.reply('❌ 未找到会员信息');
            return;
          }
          const waitMsg = await ctx.reply(`🔍 正在查询 ${memberName} 的关联信息...`);
          const resultText = await queryMemberAssociation(memberName);
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
        await ctx.answerCallbackQuery({ text: '正在查询对打对冲...' });
        try {
          const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
          const memberName = evalRecord?.memberName || '';
          if (!memberName) {
            await ctx.reply('❌ 未找到会员信息');
            return;
          }
          const waitMsg = await ctx.reply(`🎯 正在查询 ${memberName} 的对打对冲信息...`);
          const resultText = await querySubordinateHedge(memberName);
          await b.api.editMessageText(waitMsg.chat.id, waitMsg.message_id, resultText);
        } catch (err) {
          await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
        }
      } finally {
        hedgeQueryLocks.delete(orderId);
      }
      return;
    }

    const actionLabels: Record<string, string> = {
      review: '⚠️ 已人工审核',
    };

    try { await ctx.answerCallbackQuery({ text: `已记录: ${actionLabels[action] || action}` }); } catch {}

    try {
      await dbHolder.db.riskEval.updateMany({
        where: { orderId, feedback: '' },
        data: { feedback: action },
      });

      const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
      const triggeredRules = JSON.parse(evalRecord?.triggeredRules || '[]');
      const periodInfo = evalRecord?.detail ? (() => { try { const d = JSON.parse(evalRecord.detail); return d.periodInfo || ''; } catch { return ''; } })() : '';
      const memberId = evalRecord?.memberId || '';

      const feedbackData = triggeredRules.map((rule: any) => ({
        evalId: evalRecord?.id || orderId,
        ruleId: rule.id,
        feedback: action,
        memberId,
        periodInfo: ['R24', 'R25', 'R26'].includes(rule.id) ? periodInfo : '',
      }));
      if (feedbackData.length > 0) {
        await dbHolder.db.ruleFeedback.createMany({ data: feedbackData });
        invalidateMemberReviewedPeriods(memberId);
      }
    } catch (err) {
      logger.warn({ orderId, err: (err as Error).message }, '[Telegram] 记录反馈失败');
    }

    const user = ctx.from?.username || ctx.from?.first_name || '未知';
    const keyboard = new InlineKeyboard()
      .text('🔍 其他信息', `feedback:${orderId}:info`)
      .text('↔️ 对打对冲', `feedback:${orderId}:hedge`);

    try {
      const origMsg = ctx.callbackQuery?.message;
      if (origMsg && 'text' in origMsg) {
        const appended = `${origMsg.text}\n\n📋 ${user} 对订单 ${orderId} 的处理: ${actionLabels[action] || action}`;
        await ctx.editMessageText(safeTruncate(appended, 4096), { reply_markup: keyboard });
      } else {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      }
    } catch {
      try { await ctx.editMessageReplyMarkup({ reply_markup: keyboard }); } catch {}
    }
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
}

export function buildRiskAlertText(p: AlertTextParams): string {
  const { icon, label, head } = LEVEL_CONFIG[p.riskLevel] || { icon: '❓', label: '未知', head: '❓' };

  const diff = p.rechargeWithdrawDiff ?? 0;
  const diffTag = diff < 0 ? '赢' : '输';
  const diffValue = fmtNum(Math.abs(diff));
  const manualBadge = p.triggeredRules.some((r: any) => r.id === 'R29') ? ' · 手工补单' : '';
  const earlyBadge = p.isEarlyMorning ? ' · 跨日数据' : '';

  const shortDate = p.registerTime
    ? p.registerTime.replace(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[\sT](\d{1,2}:\d{2}).*/, (_, y, m, d, t) => `${y}-${parseInt(m, 10)}-${parseInt(d, 10)} ${t}`)
    : '';

  const triggeredText = p.triggeredRules
    .map((r) => {
      const sIcon = SEVERITY_ICON[r.severity || ''] || '🟡';
      const parts = r.reason.split('\n').filter((s: string) => s.trim());
      const isBettingRule = ['R24', 'R25', 'R26'].includes(r.id);
      if (isBettingRule && parts.length > 1) {
        const ruleName = r.name || r.id;
        const entryCount = parts.length;
        const MAX_SHOW = 8;
        const shown = parts.slice(0, MAX_SHOW);
        const detailLines = shown.map((s: string) => `  ${s.trim()}`).join('\n');
        const suffix = entryCount > MAX_SHOW ? `\n  ...还有 ${entryCount - MAX_SHOW} 条类似违规` : '';
        return `${sIcon} ${ruleName} ${entryCount} 条：\n${detailLines}${suffix}`;
      }
      if (parts.length <= 1) {
        return `${sIcon} ${r.reason}`;
      }
      return `${sIcon} ${parts.map((s: string) => s.trim()).join(' | ')}`;
    })
    .join('\n');

  const isLowLarge = p.riskLevel === 'LOW' && parseFloat(String(p.amount ?? '0')) >= 5000;
  const scorePart = isLowLarge ? '· 大额提款' : `${p.totalScore}分`;
  let line1 = `${head}${label} ${scorePart}${manualBadge}${earlyBadge}`;
  let line3 = `👤 账号: ${p.memberName}  上级: ${p.proxyCode}`;
  let line4 = `💰 余额: ${fmtNum(p.balance || 0)}  充提次数: ${p.depositCount} / ${p.withdrawCount}`;
  let line4b = p.topGameTypes ? `🎮 主投: ${p.topGameTypes.split('、').map(g => g + '类游戏').join('、')}` : '';
  let line5 = `💸 ${diffTag}钱: ${diffValue} 提款方式: ${p.receivingBank || '免提'}${p.receivingName ? '·' + p.receivingName : ''}`;
  let line6 = `\u{1F4C5} ${shortDate || '未知'} 💲 提款: ${fmtNum(p.amount)}`;

  const midLines = [line4, line5, line4b].filter(l => l).join('\n');
  let text = `${line1}\n\n${line3}\n${midLines}\n${line6}${triggeredText ? '\n\n' + triggeredText : ''}`;

  if (text.length > 4000) {
    let cutoff = 3990;
    const lastNewline = text.lastIndexOf('\n', cutoff);
    if (lastNewline > cutoff - 200) cutoff = lastNewline;
    text = safeTruncate(text, cutoff) + '\n...（更多省略）';
  }

  return text;
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

    const numAmount = parseFloat(String(amount ?? '0'));

    if (evalResult.riskLevel === 'LOW' && numAmount < 5000) {
      const msg = await bot.api.sendMessage(notifyChatId, `✅ ${memberName} · 提款 ${fmtNum(amount)} · 代理 ${proxyCode} · ${evalResult.orderId || ''}`);
      tgFailCount = 0;
      logger.info({ orderNo: evalResult.orderId, riskLevel: evalResult.riskLevel }, '[Telegram] ✅ 低风险通知已发送');
      return { success: true, messageId: msg.message_id };
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
    });

    let msg: { message_id: number };
    if (evalResult.orderId && (evalResult.riskLevel !== 'LOW' || numAmount >= 5000)) {
      const keyboard = new InlineKeyboard()
        .text('📋 人工审核', `feedback:${evalResult.orderId}:review`)
        .text('🔍 其他信息', `feedback:${evalResult.orderId}:info`)
        .text('↔️ 对打对冲', `feedback:${evalResult.orderId}:hedge`);
      msg = await bot.api.sendMessage(notifyChatId, text, { reply_markup: keyboard });
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
      return;
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
  }
}

/** 自动审核超过 3 分钟未被人工处理的订单 */
export async function autoReviewExpiredOrders(): Promise<void> {
  if (!bot || !notifyChatId) {
    logger.warn({ hasBot: !!bot, hasChatId: !!notifyChatId }, '[Telegram] 自动审核跳过：bot或notifyChatId未就绪');
    return;
  }

  try {
    const expireAgo = Date.now() - 150 * 1000; // 2分30秒
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
        // 与处理路径保持一致：仅当 notifiedAt 存在且已过期才计数
        const notifiedAt: number | undefined = detail.notifiedAt;
        if (!notifiedAt) return false;
        return notifiedAt <= expireAgo;
      }).length;
      if (expiredCount > 0) {
        logger.info({ total: candidates.length, expired: expiredCount }, '[Telegram] 自动审核扫描 — 已通知未审核订单');
      }
    }

    for (const ev of candidates) {
      try {
        let triggeredRules: any[] = [];
        try { triggeredRules = JSON.parse(ev.triggeredRules || '[]'); } catch {}
        // 低风险且提款 < 5000 的无需自动审核
        if (triggeredRules.length === 0) {
          let detail: Record<string, any> = {};
          try { detail = JSON.parse(ev.detail || '{}'); } catch {}
          const detailAmount = parseFloat(String(detail.orderAmount ?? '0'));
          if (detailAmount < 5000) {
            // 低风险小金额订单无需自动审核（无"人工审核"按钮），标记跳过避免永久堵塞队列
            await dbHolder.db.riskEval.updateMany({
              where: { orderId: ev.orderId, feedback: '' },
              data: { feedback: 'auto_skip' },
            });
            continue;
          }
        }

        let detail: Record<string, any> = {};
        try { detail = JSON.parse(ev.detail || '{}'); } catch {}

        // 使用 notifiedAt（通知时写入）判断超时，若缺失则跳过（无法确定通知时间）
        const notifiedAt: number = detail.notifiedAt;
        if (!notifiedAt) continue;
        if (notifiedAt > expireAgo) continue; // 未满 2 分 30 秒，跳过

        const periodInfo = detail.periodInfo || '';

        // 更新 Telegram 消息：移除"人工审核"按钮 + 追加审核文案
        const notifyMsgId = detail.notifyMsgId as number | undefined;
        const reviewTag = `📋 超时未操作 ${ev.orderId} 的处理: ⚠️ 默认已审核`;

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
        });

        const appended = `${rebuiltText}\n\n${reviewTag}`;
        const updatedKeyboard = new InlineKeyboard()
          .text('🔍 其他信息', `feedback:${ev.orderId}:info`)
          .text('↔️ 对打对冲', `feedback:${ev.orderId}:hedge`);

        let msgEdited = false;
        if (notifyMsgId && notifyChatId) {
          try {
            await bot.api.editMessageText(notifyChatId, notifyMsgId, safeTruncate(appended, 4096), { reply_markup: updatedKeyboard });
            msgEdited = true;
          } catch (e1) {
            logger.warn({ orderId: ev.orderId, err: (e1 as Error).message }, '[Telegram] 自动审核编辑消息失败，尝试发新消息');
            try {
              await bot.api.sendMessage(notifyChatId, safeTruncate(appended, 4096), { reply_markup: updatedKeyboard });
              msgEdited = true;
            } catch (e2) {
              logger.warn({ orderId: ev.orderId, err: (e2 as Error).message }, '[Telegram] 自动审核发送新消息也失败');
            }
          }
        } else if (notifyChatId) {
          try {
            await bot.api.sendMessage(notifyChatId, safeTruncate(appended, 4096), { reply_markup: updatedKeyboard });
            msgEdited = true;
          } catch (e3) {
            logger.warn({ orderId: ev.orderId, err: (e3 as Error).message }, '[Telegram] 自动审核发送消息失败（notifyMsgId缺失）');
          }
        }

        // CAS 放到最后：只有前面的操作都成功（或至少尝试过），才标记为已审核
        const upd = await dbHolder.db.riskEval.updateMany({
          where: { orderId: ev.orderId, feedback: '' },
          data: { feedback: 'review' },
        });
        if (upd.count === 0) continue; // 已被其他路径处理

        // CAS 成功后写入 RuleFeedback，避免人工审核并发时产生孤儿记录
        const feedbackData = triggeredRules.map((rule: any) => ({
          evalId: ev.id,
          ruleId: rule.id,
          feedback: 'review',
          memberId: ev.memberId,
          periodInfo: ['R24', 'R25', 'R26'].includes(rule.id) ? periodInfo : '',
        }));
        if (feedbackData.length > 0) {
          await dbHolder.db.ruleFeedback.createMany({ data: feedbackData }).catch((err) => {
            logger.warn({ orderId: ev.orderId, err: (err as Error).message }, '[Telegram] 自动审核写入RuleFeedback失败');
          });
        }

        invalidateMemberReviewedPeriods(ev.memberId);

        if (!msgEdited) {
          logger.warn({ orderId: ev.orderId }, '[Telegram] 自动审核消息编辑/发送均失败，但DB已标记为已审核');
        }
        logger.info({ orderId: ev.orderId, memberName: ev.memberName }, '[Telegram] 超时订单已自动审核');
      } catch (err) {
        logger.warn({ orderId: ev.orderId, err: (err as Error).message }, '[Telegram] 自动审核单条失败');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Telegram] 自动审核扫描失败');
  }
}

export function getBot(): Bot {
  if (!bot) throw new Error('Telegram Bot 尚未初始化，请先调用 startTelegramBot()');
  return bot;
}
