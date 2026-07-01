import { Bot, InlineKeyboard } from 'grammy';
import { type WithdrawOrder } from './ws-client';
import { apiClient } from './api-client';
import { getAllRules, setRuleEnabled, getRuleStates, invalidateMemberReviewedPeriods } from './rule-engine';
import type { EvaluationResult } from './rule-types';
import { dbHolder } from './db';
import { LRUCache } from 'lru-cache';
import { getMemberProfileText, ipMemberCache, deviceMemberCache, memberLoginLogsCache } from './evaluator';
import { logger } from './logger';
import { fmtNum, extractProxyCode, encrypt, decrypt, formatBeijingTime } from './utils';
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

const lastActionTime = new LRUCache<number, number>({ max: 10000, ttl: 24 * 3600000 });
const RATE_LIMIT_MS = 1500;
const infoQueryLocks = new Set<string>();
const hedgeQueryLocks = new Set<string>();

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
    const SUB_NEED = 30;
    while (subPage <= 5) {
      const subRes = await apiClient.getMembersByAgency(memberName, subPage, 200);
      const batch = subRes?.items || (Array.isArray(subRes?.data) ? subRes.data : []) || [];
      subMembers.push(...batch);
      if (batch.length < 200 || subMembers.length >= SUB_NEED) break;
      subPage++;
    }

    const subNames = subMembers
      .map((m: any) => m.memberName || m.userName || '')
      .filter((n: string) => n && n !== memberName)
      .slice(0, 30) as string[];

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

  b.callbackQuery(/^feedback:(.+):(.+)$/, async (ctx) => {
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
      // CAS: 仅 feedback 为空时更新，防止与自动审核并发时重复写 RuleFeedback
      const upd = await dbHolder.db.riskEval.updateMany({
        where: { orderId, feedback: '' },
        data: { feedback: action },
      });

      if (upd.count > 0) {
        const evalRecord = await dbHolder.db.riskEval.findUnique({ where: { orderId } });
        const triggeredRules = JSON.parse(evalRecord?.triggeredRules || '[]');
        const periodInfo = evalRecord?.detail ? (() => { try { const d = JSON.parse(evalRecord.detail); return d.periodInfo || ''; } catch { return ''; } })() : '';
        const memberId = evalRecord?.memberId || '';

        const feedbackData = triggeredRules.map((rule: any) => ({
          evalId: evalRecord?.id || orderId,
          ruleId: rule.id,
          feedback: action,
          memberId,
          periodInfo: ['R24', 'R25', 'R26', 'R27'].includes(rule.id) ? periodInfo : '',
        }));
        if (feedbackData.length > 0) {
          await dbHolder.db.ruleFeedback.createMany({ data: feedbackData });
          invalidateMemberReviewedPeriods(memberId);
        }
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
        await ctx.editMessageText(appended.substring(0, 4096), { reply_markup: keyboard });
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
  receivingBank: string;
  receivingName: string;
  registerTime: string;
  amount: string | number;
  triggeredRules: Array<{ id: string; name?: string; severity?: string; reason: string }>;
  isEarlyMorning?: boolean;
  mainGameType?: string;
}

export function buildRiskAlertText(p: AlertTextParams): string {
  const { icon, label, head } = LEVEL_CONFIG[p.riskLevel] || { icon: '❓', label: '未知', head: '❓' };

  const diff = p.rechargeWithdrawDiff ?? 0;
  const diffTag = diff < 0 ? '赢' : '输';
  const diffValue = fmtNum(Math.abs(diff));
  const manualBadge = p.triggeredRules.some((r: any) => r.id === 'R29') ? ' · 手工补单' : '';
  const earlyBadge = p.isEarlyMorning ? ' · 跨日数据' : '';

  const shortDate = p.registerTime
    ? p.registerTime.replace(/^(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}:\d{2}).*/, (_, y, m, d, t) => `${y}-${parseInt(m, 10)}-${parseInt(d, 10)} ${t}`)
    : '';

  const triggeredText = p.triggeredRules
    .map((r) => {
      const sIcon = SEVERITY_ICON[r.severity || ''] || '🟡';
      const parts = r.reason.split('\n').filter((s: string) => s.trim());
      const isBettingRule = ['R24', 'R25', 'R26', 'R27'].includes(r.id);
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

  let line1 = `${head}${label} ${p.totalScore}分${manualBadge}${earlyBadge}`;
  let line3 = `👤 账号: ${p.memberName}  上级: ${p.proxyCode}`;
  let line4 = `💰 余额: ${fmtNum(p.balance || 0)}  充提次数: ${p.depositCount} / ${p.withdrawCount}`;
  let line5 = `💸 ${diffTag}钱: ${diffValue} 提款方式: ${p.receivingBank || '未知渠道'}${p.receivingName ? '·' + p.receivingName : ''}`;
  let line6 = `\u{1F4C5} ${shortDate || '未知'} 💲 提款: ${fmtNum(p.amount)}`;
  // 主投游戏类型（仅当近7天有投注数据时显示）
  let lineGame = p.mainGameType ? `\u{1F3AE} 主投: ${p.mainGameType}` : '';

  let text = `${line1}\n\n${line3}\n${line4}\n${line5}${lineGame ? '\n' + lineGame : ''}\n${line6}\n\n${triggeredText || '  无'}`;

  if (text.length > 4000) {
    let cutoff = 3990;
    const lastNewline = text.lastIndexOf('\n', cutoff);
    if (lastNewline > cutoff - 200) cutoff = lastNewline;
    text = text.substring(0, cutoff) + '\n...（更多省略）';
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

    if (evalResult.riskLevel === 'LOW') {
      const numAmount = parseFloat(String(amount ?? '0'));
      if (numAmount >= 5000) {
        // 大额提款，展示完整会员信息 + 人工审核按钮，超时后自动审核
        const lowText = buildLowAmountAlertText({
          memberName,
          proxyCode,
          balance: evalResult.balance || order?.balance || 0,
          depositCount: evalResult.depositCount ?? 0,
          withdrawCount: evalResult.withdrawCount ?? 0,
          rechargeWithdrawDiff: evalResult.rechargeWithdrawDiff ?? 0,
          receivingBank: order?.receivingBank || '',
          receivingName: String(order?.receivingName || order?.realName || order?.memberRealName || order?.accountName || order?.bankAccountName || order?.receiving_name || ''),
          registerTime: evalResult.registerTime || '',
          amount,
        });
        const lowKeyboard = new InlineKeyboard()
          .text('📋 人工审核', `feedback:${evalResult.orderId}:review`)
          .text('🔍 其他信息', `feedback:${evalResult.orderId}:info`)
          .text('↔️ 对打对冲', `feedback:${evalResult.orderId}:hedge`);
        const msg = await bot.api.sendMessage(notifyChatId, lowText, { reply_markup: lowKeyboard });
        tgFailCount = 0;
        logger.info({ orderNo: evalResult.orderId, amount: numAmount }, '[Telegram] ✅ 低风险大额通知已发送（带审核按钮）');
        return { success: true, messageId: msg.message_id, text: lowText };
      }
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
      balance: evalResult.balance || order?.balance || '',
      depositCount: evalResult.depositCount ?? 0,
      withdrawCount: evalResult.withdrawCount ?? 0,
      rechargeWithdrawDiff: evalResult.rechargeWithdrawDiff ?? 0,
      receivingBank: order?.receivingBank || '',
      receivingName: String(order?.receivingName || order?.realName || order?.memberRealName || order?.accountName || order?.bankAccountName || order?.receiving_name || ''),
      registerTime: evalResult.registerTime || '',
      amount,
      triggeredRules: evalResult.triggeredRules,
      isEarlyMorning: evalResult.isEarlyMorning,
      mainGameType: evalResult.mainGameType,
    });

    let msg: { message_id: number };
    if (evalResult.orderId) {
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

const AUTO_REVIEW_TIMEOUT_MS = 150 * 1000; // 2 分 30 秒

/** 构建低风险大额提款通知文本（sendRiskAlert 和 autoReview 共用） */
function buildLowAmountAlertText(p: {
  memberName: string;
  proxyCode: string;
  balance: string | number;
  depositCount: number;
  withdrawCount: number;
  rechargeWithdrawDiff: number;
  receivingBank: string;
  receivingName: string;
  registerTime: string;
  amount: string | number;
}): string {
  const diff = p.rechargeWithdrawDiff ?? 0;
  const diffTag = diff < 0 ? '赢' : '输';
  const diffValue = fmtNum(Math.abs(diff));
  const shortDate = p.registerTime
    ? p.registerTime.replace(/^(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}:\d{2}).*/, (_, y: string, m: string, d: string, t: string) => `${y}-${parseInt(m, 10)}-${parseInt(d, 10)} ${t}`)
    : '';
  return [
    `✅ 低风险 · 大额提款`,
    ``,
    `👤 账号: ${p.memberName}  上级: ${p.proxyCode}`,
    `💰 余额: ${fmtNum(p.balance || 0)}  充提次数: ${p.depositCount} / ${p.withdrawCount}`,
    `💸 ${diffTag}钱: ${diffValue} 提款方式: ${p.receivingBank || '未知渠道'}${p.receivingName ? '·' + p.receivingName : ''}`,
    `📅 ${shortDate || '未知'} 💲 提款: ${fmtNum(p.amount)}`,
  ].join('\n');
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

/** 对单条 RiskEval 记录执行自动审核（DB 更新 + RuleFeedback + 消息编辑）。
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
  // 已审核或未通知的订单跳过
  if (ev.feedback !== '') return;
  if (!ev.notified) return;
  if (!bot || !notifyChatId) return;

  let triggeredRules: any[] = [];
  try { triggeredRules = JSON.parse(ev.triggeredRules || '[]'); } catch {}

  let detail: Record<string, any> = {};
  try { detail = JSON.parse(ev.detail || '{}'); } catch {}

  // 判断是否需要自动审核：非 LOW（均有审核按钮）或 LOW + 金额 >= 5000
  const orderAmount = parseFloat(String(detail.orderAmount ?? '0'));
  const isLowAutoReview = ev.riskLevel === 'LOW' && orderAmount >= 5000;
  const hasReviewButton = ev.riskLevel !== 'LOW' && triggeredRules.length > 0;
  if (!hasReviewButton && !isLowAutoReview) return;

  // 精确超时判断：专用列 notifiedAt，回退到 createdAt（兼容旧数据）
  const effectiveNotifiedAt = ev.notifiedAt ? ev.notifiedAt.getTime() : new Date(ev.createdAt).getTime();
  if (Date.now() - effectiveNotifiedAt < AUTO_REVIEW_TIMEOUT_MS) return;

  // CAS 更新 feedback 防止重复处理
  const upd = await dbHolder.db.riskEval.updateMany({
    where: { orderId: ev.orderId, feedback: '' },
    data: { feedback: 'review' },
  });
  if (upd.count === 0) return;

  // 写入 RuleFeedback 记录（与人工审核行为一致：所有触发规则均记录）
  if ((hasReviewButton || isLowAutoReview) && triggeredRules.length > 0) {
    const periodInfo = detail.periodInfo || '';
    const feedbackData = triggeredRules.map((rule: any) => ({
      evalId: ev.id,
      ruleId: rule.id,
      feedback: 'review',
      memberId: ev.memberId,
      periodInfo: ['R24', 'R25', 'R26', 'R27'].includes(rule.id) ? periodInfo : '',
    }));
    if (feedbackData.length > 0) {
      await dbHolder.db.ruleFeedback.createMany({ data: feedbackData });
      invalidateMemberReviewedPeriods(ev.memberId);
    }
  }

  // 更新 Telegram 消息：移除"人工审核"按钮 + 追加审核文案
  const notifyMsgId = ev.notifyMsgId;
  const reviewTag = `📋 超时未操作 ${ev.orderId} 的处理: ⚠️ 默认已审核`;

  let rebuiltText: string;
  if (isLowAutoReview) {
    rebuiltText = buildLowAmountAlertText({
      memberName: ev.memberName,
      proxyCode: (detail.proxyCode as string) || '',
      balance: (detail.balance as string | number) || '',
      depositCount: (detail.depositCount as number) ?? 0,
      withdrawCount: (detail.withdrawCount as number) ?? 0,
      rechargeWithdrawDiff: (detail.rechargeWithdrawDiff as number) ?? 0,
      receivingBank: (detail.receivingBank as string) || '',
      receivingName: (detail.receivingName as string) || '',
      registerTime: (detail.registerTime as string) || '',
      amount: (detail.orderAmount as string | number) || '',
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
      receivingBank: (detail.receivingBank as string) || '',
      receivingName: (detail.receivingName as string) || '',
      registerTime: (detail.registerTime as string) || '',
      amount: (detail.orderAmount as string | number) || '',
      triggeredRules,
      isEarlyMorning: (detail.isEarlyMorning as boolean) || false,
      mainGameType: (detail.mainGameType as string) || undefined,
    });
  }

  const appended = `${rebuiltText}\n\n${reviewTag}`;
  const updatedKeyboard = new InlineKeyboard()
    .text('🔍 其他信息', `feedback:${ev.orderId}:info`)
    .text('↔️ 对打对冲', `feedback:${ev.orderId}:hedge`);

  if (notifyMsgId && notifyChatId) {
    try {
      await bot.api.editMessageText(notifyChatId, notifyMsgId, appended.substring(0, 4096), { reply_markup: updatedKeyboard });
    } catch (editErr) {
      logger.warn({ orderId: ev.orderId, err: (editErr as Error).message }, '[Telegram] 自动审核编辑消息失败，尝试发新消息');
      try { await bot.api.sendMessage(notifyChatId, appended.substring(0, 4096), { reply_markup: updatedKeyboard }); } catch (sendErr) {
        logger.warn({ orderId: ev.orderId, err: (sendErr as Error).message }, '[Telegram] 自动审核发新消息也失败');
      }
    }
  } else if (notifyChatId) {
    logger.info({ orderId: ev.orderId }, '[Telegram] 自动审核 notifyMsgId 缺失，发新消息');
    try { await bot.api.sendMessage(notifyChatId, appended.substring(0, 4096), { reply_markup: updatedKeyboard }); } catch (sendErr) {
      logger.warn({ orderId: ev.orderId, err: (sendErr as Error).message }, '[Telegram] 自动审核发新消息失败');
    }
  }

  logger.info({ orderId: ev.orderId, memberName: ev.memberName, riskLevel: ev.riskLevel }, '[Telegram] 超时订单已自动审核');
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

    // Query 2: LOW 风险订单（大额提款可能有审核按钮）
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
