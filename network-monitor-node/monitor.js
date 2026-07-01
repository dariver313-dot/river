/**
 * 网络连通性监控 - 三层混合检测 (Node.js 版)
 * 第一层：服务器直接请求（快速存活检测）
 * 第二层：BOCE 被墙/DNS污染检测
 * 第三层：BOCE 全国Ping检测
 */

require('dotenv').config();

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;

// ==================== 北京时间工具 ====================

const TZ = 'Asia/Shanghai';

const beijing = {
  iso: () => new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace('T', ' '),
  full: () => new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false }),
  date: () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }),
};

// ==================== 日志 ====================

const logger = {
  _ts: () => beijing.iso(),
  info: (msg) => console.log(`[${logger._ts()}] INFO  ${msg}`),
  warn: (msg) => console.warn(`[${logger._ts()}] WARN  ${msg}`),
  error: (msg) => console.error(`[${logger._ts()}] ERROR ${msg}`),
};

// ==================== 配置加载（从 .env 读取，带缓存）====================

let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;

  const config = {
    tg_bot_token: process.env.TG_BOT_TOKEN || '',
    tg_chat_id: process.env.TG_CHAT_ID || '',
    boce_api_key: process.env.BOCE_API_KEY || '',
    allowed_users: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(id => Number(id)),
    auto_check_interval_min: Number(process.env.AUTO_CHECK_INTERVAL_MIN) || 0,
    auto_check_group_count: Number(process.env.AUTO_CHECK_GROUP_COUNT) || 4,
    daily_report_hour: process.env.DAILY_REPORT_HOUR ? Number(process.env.DAILY_REPORT_HOUR) : -1,
    anomaly_threshold: Number(process.env.ANOMALY_THRESHOLD) || 5,
  };

  // 基本校验
  if (!config.tg_bot_token) {
    logger.error('缺少 TG_BOT_TOKEN，请在 .env 文件中配置');
    process.exit(1);
  }

  _configCache = config;
  return config;
}

let _sitesCache = null;

function loadSites(category) {
  if (!_sitesCache) {
    const sitesPath = path.join(BASE_DIR, 'sites.json');
    try {
      _sitesCache = JSON.parse(fs.readFileSync(sitesPath, 'utf-8'));
    } catch (e) {
      logger.error(`读取 sites.json 失败: ${e.message}`);
      _sitesCache = {};
    }
  }

  if (category) {
    if (_sitesCache[category]) return { [category]: _sitesCache[category] };
    logger.warn(`分类 '${category}' 不存在，可用分类: ${Object.keys(_sitesCache).join(', ')}`);
    return {};
  }
  return _sitesCache;
}

function clearCache() {
  _configCache = null;
  _sitesCache = null;
  _cachedNodeIds = null;
}

function getAllUrls(sitesData) {
  const urls = [];
  for (const [cat, urlList] of Object.entries(sitesData)) {
    for (const url of urlList) {
      urls.push({ url, category: cat });
    }
  }
  return urls;
}

function extractDomain(url) {
  return url.replace('https://', '').replace('http://', '').split('/')[0].split(':')[0];
}

// ==================== BOCE 全国 HTTP 检测 ====================

let _cachedNodeIds = null;
let _cachedNodeIdsTime = 0;
const NODE_CACHE_TTL = 30 * 60 * 1000;

async function getNodeIds(boceKey) {
  const now = Date.now();
  if (_cachedNodeIds && (now - _cachedNodeIdsTime) < NODE_CACHE_TTL) {
    return _cachedNodeIds;
  }
  try {
    const nodeRes = await fetch(`https://api.boce.com/v3/node/list?key=${boceKey}`);
    const nodeData = await nodeRes.json();
    if (nodeData.error_code === 0 && nodeData.data && nodeData.data.list) {
      _cachedNodeIds = nodeData.data.list.map(n => n.id).join(',');
      _cachedNodeIdsTime = now;
      return _cachedNodeIds;
    }
  } catch (e) {
    logger.error(`获取节点列表失败: ${e.message}`);
  }
  return null;
}

async function runCurlCheck(urls, boceKey, onProgress = null) {
  if (!boceKey) {
    logger.error('BOCE API Key 未配置，无法进行省份检测');
    return [];
  }

  const nodeIds = await getNodeIds(boceKey);
  if (!nodeIds) {
    logger.error('获取BOCE节点列表失败');
    return [];
  }

  const results = [];
  // 逐个检测，每个域名一个 BOCE 任务
  for (let i = 0; i < urls.length; i++) {
    const { url, category } = urls[i];
    const domain = extractDomain(url);

    try {
      if (onProgress) onProgress(`📡 网络检测中 (${i + 1}/${urls.length}) ${domain}...`);

      // 创建 curl 任务
      const createRes = await fetch(
        `https://api.boce.com/v3/task/create/curl?key=${boceKey}&host=${domain}&node_ids=${nodeIds}`
      );
      const createData = await createRes.json();

      if (createData.error_code !== 0) {
        logger.warn(`  ${domain}: 创建任务失败 - ${createData.error}`);
        results.push({ url, category, domain, nodes: [], error: createData.error });
        continue;
      }

      const taskId = createData.data.id;

      // 轮询结果（每10秒，最多2分钟）
      let taskDone = false;
      for (let t = 0; t < 12; t++) {
        await sleep(10000);
        const resultRes = await fetch(`https://api.boce.com/v3/task/curl/${taskId}?key=${boceKey}`);
        const resultData = await resultRes.json();

        if (resultData.done) {
          const nodes = parseCurlResults(resultData);
          const okCount = nodes.filter(n => n.ok).length;
          logger.info(`  ${domain}: ${okCount}/${nodes.length}省正常`);
          results.push({ url, category, domain, nodes, error: null });
          taskDone = true;
          break;
        }
      }

      if (!taskDone) {
        logger.warn(`  ${domain}: 检测超时`);
        results.push({ url, category, domain, nodes: [], error: '检测超时' });
      }
    } catch (e) {
      logger.error(`  ${domain}: ${e.message}`);
      results.push({ url, category, domain, nodes: [], error: e.message });
    }
  }

  return results;
}

function parseCurlResults(data) {
  return (data.list || []).map(item => {
    const hasValidHttpCode = item.http_code && item.http_code > 0;
    const isTimeout = (item.time_total || 0) >= 8;
    const hasError = item.error_code !== 0;
    const hasErrorMsg = item.error && item.error.trim().length > 0;

    // ok 判定：必须有有效HTTP状态码，且无错误，且不超时
    const ok = hasValidHttpCode && !hasError && !isTimeout && !hasErrorMsg;

    let reason = '';
    if (hasError) reason = item.error;
    else if (hasErrorMsg) reason = item.error;
    else if (!hasValidHttpCode) reason = '无响应';
    else if (isTimeout) reason = '响应超时';

    return {
      node: item.node_name || '未知节点',
      http_code: item.http_code || 0,
      time_total: item.time_total || 0,
      ok,
      error: reason,
    };
  });
}

function writeReportLog(report) {
  try {
    const line = `\n===== ${beijing.iso()} =====\n${report}\n`;
    fs.appendFileSync(path.join(BASE_DIR, 'reports.log'), line, 'utf-8');
  } catch (_) {}
}

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  while (text) {
    if (text.length <= maxLen) { parts.push(text); break; }
    let splitPos = text.lastIndexOf('\n', maxLen);
    if (splitPos <= 0) splitPos = maxLen;
    parts.push(text.substring(0, splitPos));
    text = text.substring(splitPos + 1);
  }
  return parts;
}

// ==================== 报告 ====================

function formatReport(results, threshold = 5) {
  const now = beijing.full();
  const dateStr = beijing.date();

  // 分类汇总
  const badList = [];   // 异常
  const okList = [];    // 正常（含轻微波动）
  const failList = [];  // 检测失败

  for (const r of results) {
    if (r.error && (!r.nodes || r.nodes.length === 0)) {
      failList.push(r);
      continue;
    }

    const totalNodes = r.nodes.length;
    const okNodes = r.nodes.filter(n => n.ok);
    const badNodes = r.nodes.filter(n => !n.ok);
    const okCount = okNodes.length;
    const badCount = badNodes.length;
    const badPct = totalNodes > 0 ? (badCount / totalNodes) * 100 : 0;

    // 响应时间统计（仅正常节点）
    const times = okNodes.map(n => n.time_total || 0).filter(t => t > 0);
    const avgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;

    // 按省份聚合异常节点
    const byProvince = {};
    for (const n of badNodes) {
      const isp = n.node.match(/(联通|电信|移动|铁通|教育网)$/)?.[1] || '';
      const prov = isp ? n.node.slice(0, -isp.length) : n.node;
      if (!byProvince[prov]) byProvince[prov] = [];
      byProvince[prov].push({ isp, error: n.error, http_code: n.http_code, time: n.time_total });
    }

    const info = { r, totalNodes, okCount, badCount, badPct, avgTime, badNodes, byProvince };

    if (badPct > threshold) {
      badList.push(info);
    } else {
      okList.push(info);
    }
  }

  // ---- 构建报告 ----
  let report = `📡 日报 ${dateStr}\n\n`;

  // 摘要
  report += `🚨 异常 ${badList.length}个 | ✅ 正常 ${okList.length}个`;
  if (failList.length > 0) report += ` | ❌ 失败 ${failList.length}个`;
  report += '\n';

  // 异常详情
  if (badList.length > 0) {
    report += `\n── 异常详情 ──\n\n`;
    for (const info of badList) {
      const { r, totalNodes, okCount, badCount, badPct, avgTime, byProvince } = info;

      if (badPct > 50) {
        report += `🚨 ${r.domain}\n`;
        report += `  ${badCount}/${totalNodes}省挂(异常率${badPct.toFixed(0)}%) | 全部无响应\n\n`;
      } else {
        report += `⚠️ ${r.domain}\n`;
        report += `  ${okCount}通/${badCount}挂/${totalNodes}省(异常率${badPct.toFixed(0)}%)`;
        if (avgTime > 0) report += ` | 均速${avgTime.toFixed(1)}s`;
        report += '\n';

        // 列出异常省份（同省份按错误类型合并运营商）
        const provEntries = Object.entries(byProvince);
        for (const [prov, items] of provEntries) {
          // 按错误类型分组
          const byError = {};
          for (const item of items) {
            const errKey = item.error || '未知';
            if (!byError[errKey]) byError[errKey] = [];
            byError[errKey].push(item.isp);
          }
          for (const [errKey, isps] of Object.entries(byError)) {
            const validIsps = isps.filter(Boolean);
            const ispTag = validIsps.length > 0 ? `[${validIsps.join('/')}]` : '';
            report += `  · ${prov}${ispTag} ${errKey}\n`;
          }
        }
        report += '\n';
      }
    }
  }

  // 正常概况
  if (okList.length > 0) {
    report += `── 正常概况 ──\n\n`;
    for (const info of okList) {
      const { r, totalNodes, okCount, badCount, badPct, avgTime, byProvince } = info;

      if (badCount === 0) {
        report += `✅ ${r.domain} ${totalNodes}省全通`;
        if (avgTime > 0) report += ` 均速${avgTime.toFixed(1)}s`;
        report += '\n';
      } else {
        report += `✅ ${r.domain} ${okCount}通/${badCount}波动/${totalNodes}省`;
        if (avgTime > 0) report += ` 均速${avgTime.toFixed(1)}s`;
        report += '\n';

        // 波动省份简列（同省份合并运营商）
        const provNames = [];
        for (const [prov, items] of Object.entries(byProvince)) {
          const isps = items.map(i => i.isp).filter(Boolean);
          const ispTag = isps.length > 0 ? `[${isps.join('/')}]` : '';
          provNames.push(`${prov}${ispTag}`);
        }
        report += `  ⚡ ${provNames.join(' · ')}\n`;
      }
    }
  }

  // 失败
  if (failList.length > 0) {
    report += `\n── 检测失败 ──\n\n`;
    for (const r of failList) {
      report += `❌ ${r.domain} ${r.error}\n`;
    }
  }

  return report;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 导出 ====================

module.exports = {
  loadConfig, loadSites, clearCache, getAllUrls, extractDomain,
  splitMessage, logger,
  runCurlCheck, formatReport, writeReportLog, beijing,
};

