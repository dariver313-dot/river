'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { loadDailyOrders } = require('./lib/auth-client');
const { loadConfig, saveConfig } = require('./lib/config');
const { getSettings } = require('./lib/env');
const { buildReport } = require('./lib/report');
const { buildOutputWorkbook, getExportIssues, getTemplateSchema, readWorkbookInfo } = require('./lib/xlsx-template');

const rootDir = __dirname;
const settings = getSettings(rootDir);
const dataDir = path.join(rootDir, 'data');
const templatesDir = path.join(rootDir, 'templates');
const outputsDir = path.join(rootDir, 'outputs');
const publicDir = path.join(rootDir, 'public');
const reportCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 8;

let config;

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : '服务发生未知错误';
  if (statusCode >= 500) console.error(`[Balance Sheet] ${message}`);
  json(res, statusCode, { success: false, error: statusCode >= 500 ? '处理失败，请查看服务日志' : message });
}

async function readJson(req) {
  const expectedLength = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(expectedLength) || expectedLength > settings.maxUploadBytes * 1.4) {
    const error = new Error('请求内容过大');
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > settings.maxUploadBytes * 1.4) {
      const error = new Error('请求内容过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求必须是 JSON');
    error.statusCode = 400;
    throw error;
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function safeTemplatePath(filename) {
  if (typeof filename !== 'string' || path.basename(filename) !== filename || !filename.toLowerCase().endsWith('.xlsx')) {
    const error = new Error('模板文件名无效');
    error.statusCode = 400;
    throw error;
  }
  return path.join(templatesDir, filename);
}

function decodeUpload(value, name) {
  if (typeof value !== 'string') return null;
  const match = /^data:application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) {
    const error = new Error(`${name}必须是 .xlsx 文件`);
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > settings.maxUploadBytes) {
    const error = new Error(`${name}超过大小限制`);
    error.statusCode = 413;
    throw error;
  }
  return buffer;
}

async function listTemplates() {
  await fs.mkdir(templatesDir, { recursive: true });
  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.xlsx')).map(entry => entry.name).sort();
}

async function currentTemplate() {
  const filename = safeTemplatePath(config.templateFile);
  const buffer = await fs.readFile(filename);
  const schema = await getTemplateSchema(buffer);
  return { buffer, schema };
}

function cacheReport(report, previousWorkbookBuffer, exportIssues) {
  const now = Date.now();
  for (const [id, item] of reportCache) if (item.expiresAt <= now) reportCache.delete(id);
  if (reportCache.size >= MAX_CACHE_ENTRIES) reportCache.delete(reportCache.keys().next().value);
  const id = crypto.randomUUID();
  reportCache.set(id, {
    report,
    templateFile: config.templateFile,
    previousWorkbookBuffer,
    exportIssues,
    expiresAt: now + CACHE_TTL_MS,
  });
  return id;
}

function previewPayload(reportId, report, template, exportIssues) {
  return {
    success: true,
    data: {
      reportId,
      date: report.date,
      template: { adapter: template.adapter, displayName: template.displayName, channelCount: template.channels.length },
      totals: report.totals,
      channels: report.channels.map(channel => ({
        id: channel.id,
        name: channel.name,
        rechargeAmount: channel.rechargeAmount,
        withdrawAmount: channel.withdrawAmount,
        feeAmount: channel.feeAmount,
        pendingAmount: channel.pendingAmount,
        manualRechargeAmount: channel.manualRechargeAmount,
        transferOutAmount: channel.transferOutAmount,
        rechargeCount: channel.rechargeCount,
        withdrawCount: channel.withdrawCount,
        note: channel.note,
      })),
      unresolved: report.unresolved,
      ambiguous: report.ambiguous,
      exportIssues,
      canExport: report.canExport && exportIssues.length === 0,
      sourceTotals: {
        recharge: { totalNum: report.sources.recharge.totalNum, sumAmount: report.sources.recharge.sumAmount },
        withdraw: { totalNum: report.sources.withdraw.totalNum, sumAmount: report.sources.withdraw.sumAmount },
      },
    },
  };
}

async function configPayload() {
  const template = await currentTemplate();
  return {
    success: true,
    data: {
      config,
      templates: await listTemplates(),
      template: { adapter: template.schema.adapter, displayName: template.schema.displayName, channels: template.schema.channels.map(channel => ({ id: channel.id, name: channel.name })) },
    },
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/config') {
    json(res, 200, await configPayload());
    return;
  }
  if (req.method === 'PUT' && pathname === '/api/config') {
    config = await saveConfig(dataDir, await readJson(req));
    json(res, 200, await configPayload());
    return;
  }
  if (req.method === 'POST' && pathname === '/api/templates') {
    const body = await readJson(req);
    const filename = String(body.filename || '').trim();
    const destination = safeTemplatePath(filename);
    const buffer = decodeUpload(body.file, '模板文件');
    const info = await readWorkbookInfo(buffer);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, buffer);
    await fs.rename(temporary, destination);
    config = await saveConfig(dataDir, { ...config, templateFile: filename });
    json(res, 201, { success: true, data: { filename, template: info } });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/report/preview') {
    const body = await readJson(req);
    if (!validDate(body.date)) {
      const error = new Error('请选择有效的报表日期');
      error.statusCode = 400;
      throw error;
    }
    const previousWorkbookBuffer = body.previousWorkbook ? decodeUpload(body.previousWorkbook, '上一日报表') : null;
    const { buffer: templateBuffer, schema } = await currentTemplate();
    const orders = await loadDailyOrders(settings, body.date, config.pageSize);
    const report = buildReport(schema, config, orders, body.adjustments || []);
    const exportIssues = await getExportIssues(templateBuffer, report, previousWorkbookBuffer);
    const reportId = cacheReport(report, previousWorkbookBuffer, exportIssues);
    json(res, 200, previewPayload(reportId, report, schema, exportIssues));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/report/export') {
    const body = await readJson(req);
    const cached = reportCache.get(body.reportId);
    if (!cached || cached.expiresAt <= Date.now()) {
      reportCache.delete(body.reportId);
      const error = new Error('预览已过期，请重新查询订单');
      error.statusCode = 409;
      throw error;
    }
    if (!cached.report.canExport || cached.exportIssues.length) {
      const error = new Error('存在未匹配渠道、重复匹配或模板写入问题，不能导出');
      error.statusCode = 409;
      throw error;
    }
    const templatePath = safeTemplatePath(cached.templateFile);
    const output = await buildOutputWorkbook(await fs.readFile(templatePath), cached.report, cached.previousWorkbookBuffer);
    const baseName = path.basename(cached.templateFile, '.xlsx');
    const filename = `${baseName}${cached.report.date.slice(5).replace('-', '.')}.xlsx`;
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.writeFile(path.join(outputsDir, filename), output);
    reportCache.delete(body.reportId);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': output.length,
      'Cache-Control': 'no-store',
    });
    res.end(output);
    return;
  }
  json(res, 404, { success: false, error: '接口不存在' });
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`)) {
    json(res, 403, { success: false, error: '禁止访问' });
    return;
  }
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    json(res, 404, { success: false, error: '页面不存在' });
  }
}

async function main() {
  await Promise.all([fs.mkdir(templatesDir, { recursive: true }), fs.mkdir(outputsDir, { recursive: true })]);
  config = await loadConfig(dataDir);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else await serveStatic(res, pathname);
    } catch (error) {
      sendError(res, error);
    }
  });
  server.listen(settings.port, settings.host, () => console.log(`Balance Sheet 已启动：http://${settings.host}:${settings.port}`));
}

main().catch(error => {
  console.error(`Balance Sheet 启动失败：${error.message}`);
  process.exit(1);
});
