/**
 * HTTP 服务器模块
 *
 * 从 index.ts 提取，提供 HTTP API 路由：健康检查、规则管理、评估查询。
 * 通过 ServerDeps 注入所有外部依赖，避免直接引用模块级变量。
 */

import http from 'http';
import crypto from 'crypto';
import { dbHolder } from './db';
import { getAllRules, setRuleEnabled, getRuleStates, invalidateActiveRuleIds } from './rule-engine';
import { apiClient } from './api-client';
import { getReceivingInfoCache, getAgentWithdrawCache } from './evaluator';
import { logger } from './logger';
import type { LRUCache } from 'lru-cache';
export interface ServerDeps {
  /** 最后成功轮询时间戳（毫秒） */
  getLastPollTime: () => number;
  /** 轮询间隔（毫秒） */
  getPollInterval: () => number;
  /** 已评估订单缓存，规则变更时需清除 */
  evaluatedOrderCache: LRUCache<string, boolean>;
}

export function createServer(deps: ServerDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'http://127.0.0.1:3000');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // auth-service 迁移后，HTTP API 使用 AUTH_API_KEY 做 Bearer 认证
    // /health 和 / 始终公开，其余路由需要 Bearer 认证
    const isPublic = ['/health', '/'].includes(url.pathname);
    const serverApiKey = process.env.AUTH_API_KEY || '';
    if (!isPublic) {
      if (!serverApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized - AUTH_API_KEY not configured' }));
        return;
      }
      const authHeader = req.headers.authorization || '';
      const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!headerToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const headerBuf = Buffer.from(headerToken);
      const keyBuf = Buffer.from(serverApiKey);
      if (headerBuf.length !== keyBuf.length || !crypto.timingSafeEqual(headerBuf, keyBuf)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      if (url.pathname === '/' && req.method === 'GET') {
        const hasToken = !!(process.env.AUTH_API_KEY || '');
        const [evalCount, recentEvals] = await Promise.all([
          dbHolder.db.riskEval.count(),
          dbHolder.db.riskEval.findMany({ take: 5, orderBy: { createdAt: 'desc' } }),
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          tokenConfigured: hasToken,
          totalEvaluations: evalCount,
          lastPollTime: deps.getLastPollTime() ? new Date(deps.getLastPollTime()).toISOString() : null,
          recentEvals,
          message: hasToken ? '风控机器人运行中' : '等待设置 API Token',
        }));
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        const hasToken = !!(process.env.AUTH_API_KEY || '');
        const apiHealthy = hasToken
          ? await Promise.race([
              apiClient.checkHealth(),
              new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
            ]).catch(() => false)
          : false;
        let evalCount = 0;
        try { evalCount = await dbHolder.db.riskEval.count(); } catch (err) {
          logger.warn({ err: (err as Error).message }, '[HTTP] /health DB count 失败');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: apiHealthy ? 'healthy' : hasToken ? 'degraded' : 'waiting_token',
          timestamp: new Date().toISOString(),
          tokenConfigured: hasToken,
          apiHealthy,
          totalEvaluations: evalCount,
          lastPollTime: deps.getLastPollTime() ? new Date(deps.getLastPollTime()).toISOString() : null,
          pollIntervalSec: deps.getPollInterval() / 1000,
          caches: {
            receivingInfo: getReceivingInfoCache().size,
            agentWithdraw: getAgentWithdrawCache().size,
          },
        }));
        return;
      }

      if (url.pathname === '/api/evals' && req.method === 'GET') {
        const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') || '20', 10) || 20, 1), 100);
        const riskLevel = url.searchParams.get('riskLevel');

        const where: { riskLevel?: string } = riskLevel ? { riskLevel } : {};
        const [evals, total] = await Promise.all([
          dbHolder.db.riskEval.findMany({
            where,
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
          }),
          dbHolder.db.riskEval.count({ where }),
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { list: evals, total, page, pageSize } }));
        return;
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const hasToken = !!(process.env.AUTH_API_KEY || '');
        const apiHealthy = hasToken
          ? await Promise.race([
              apiClient.checkHealth(),
              new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
            ]).catch(() => false)
          : false;
        const [evalCount, highRiskCount] = await Promise.all([
          dbHolder.db.riskEval.count(),
          dbHolder.db.riskEval.count({ where: { riskLevel: { in: ['HIGH', 'CRITICAL'] } } }),
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tokenConfigured: hasToken,
          apiHealthy,
          totalEvaluations: evalCount,
          highRiskEvaluations: highRiskCount,
          lastPollTime: deps.getLastPollTime() ? new Date(deps.getLastPollTime()).toISOString() : null,
          pollInterval: deps.getPollInterval() / 1000,
          caches: {
            receivingInfo: getReceivingInfoCache().size,
            agentWithdraw: getAgentWithdrawCache().size,
          },
        }));
        return;
      }

      if (url.pathname === '/api/rules' && req.method === 'GET') {
        const rules = getAllRules().map(r => ({
          id: r.id,
          name: r.name,
          description: r.description,
          severity: r.severity,
          group: r.group,
          enabled: r.enabled,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rules }));
        return;
      }

      if (url.pathname === '/api/rules' && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsupported Media Type，需要 Content-Type: application/json' }));
          return;
        }

        const chunks: Buffer[] = [];
        let bodySize = 0;
        const MAX_BODY_SIZE = 64 * 1024;
        const BODY_TIMEOUT = 10_000;
        let bodyConsumed = false; // 防重复响应

        const bodyTimer = setTimeout(() => {
          if (bodyConsumed) return;
          bodyConsumed = true;
          if (!res.headersSent) {
            res.writeHead(408, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '请求体读取超时' }));
          }
          req.destroy();
        }, BODY_TIMEOUT);

        req.on('data', chunk => {
          bodySize += chunk.length;
          if (bodySize > MAX_BODY_SIZE) {
            if (bodyConsumed) return;
            bodyConsumed = true;
            clearTimeout(bodyTimer);
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '请求体过大' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        req.on('error', (err) => {
          clearTimeout(bodyTimer);
          if (bodyConsumed) return;
          bodyConsumed = true;
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '请求流错误' }));
          }
          logger.warn({ err: err.message }, '[HTTP] 请求流错误');
        });

        req.on('end', async () => {
          clearTimeout(bodyTimer);
          if (bodyConsumed) return;
          bodyConsumed = true;
          try {
            const body = Buffer.concat(chunks).toString();
            const { ruleId, enabled } = JSON.parse(body);
            if (!ruleId || typeof enabled !== 'boolean') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: '需要 ruleId 和 enabled' }));
              return;
            }
            const ok = setRuleEnabled(ruleId, enabled);
            if (ok) {
              deps.evaluatedOrderCache.clear();
              invalidateActiveRuleIds();
              try {
                await dbHolder.db.botConfig.upsert({
                  where: { key: 'RULE_STATES' },
                  update: { value: JSON.stringify(getRuleStates()) },
                  create: { key: 'RULE_STATES', value: JSON.stringify(getRuleStates()) },
                });
              } catch (err) {
                logger.error({ err: (err as Error).message }, '[HTTP] 规则状态持久化失败，重启后将恢复旧状态');
              }
            }
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ok ? { success: true } : { error: '规则不存在' }));
          } catch (parseErr) {
            logger.warn({ err: (parseErr as Error).message }, '[HTTP] JSON 解析失败');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '无效 JSON' }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[HTTP] 请求处理错误');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  });

  return server;
}
