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
import type { WsClient } from './ws-client';

export interface ServerDeps {
  /** 最后成功轮询时间戳（毫秒） */
  getLastPollTime: () => number;
  /** 轮询间隔（毫秒） */
  getPollInterval: () => number;
  /** WebSocket 是否启用 */
  isWsEnabled: () => boolean;
  /** WebSocket URL */
  getWsUrl: () => string;
  /** WebSocket 客户端实例（可为 null） */
  getWsClient: () => WsClient | null;
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          timestamp: new Date().toISOString(),
          tokenConfigured: hasToken,
          message: hasToken ? '风控机器人运行中' : '等待设置 API Token',
        }));
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        const hasToken = !!(process.env.AUTH_API_KEY || '');
        const apiHealthy = hasToken ? await apiClient.checkHealth().catch(() => false) : false;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: apiHealthy ? 'healthy' : hasToken ? 'degraded' : 'waiting_token',
          timestamp: new Date().toISOString(),
          tokenConfigured: hasToken,
          apiHealthy,
          lastPollTime: deps.getLastPollTime() ? new Date(deps.getLastPollTime()).toISOString() : null,
          pollIntervalSec: deps.getPollInterval() / 1000,
          wsEnabled: deps.isWsEnabled(),
          wsConnected: deps.getWsClient()?.connected ?? false,
        }));
        return;
      }

      if (url.pathname === '/api/evals' && req.method === 'GET') {
        const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') || '20', 10) || 20, 1), 100);
        const riskLevel = url.searchParams.get('riskLevel');

        const where: { riskLevel?: string } = riskLevel ? { riskLevel } : {};
        // 使用 select 仅查询 DB 中实际存在的列，兼容 DDL 兜底建表缺少 notifyMsgId/notifiedAt 的场景
        const [evals, total] = await Promise.all([
          dbHolder.db.riskEval.findMany({
            where,
            select: {
              id: true, orderId: true, memberId: true, memberName: true,
              totalScore: true, riskLevel: true, triggeredRules: true,
              detail: true, notified: true, finalStatus: true,
              feedback: true, createdAt: true,
            },
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
        const apiHealthy = hasToken ? await apiClient.checkHealth().catch(() => false) : false;
        const evalCount = await dbHolder.db.riskEval.count();
        const highRiskCount = await dbHolder.db.riskEval.count({ where: { riskLevel: { in: ['HIGH', 'CRITICAL'] } } });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tokenConfigured: hasToken,
          apiHealthy,
          totalEvaluations: evalCount,
          highRiskEvaluations: highRiskCount,
          lastPollTime: deps.getLastPollTime() ? new Date(deps.getLastPollTime()).toISOString() : null,
          pollInterval: deps.getPollInterval() / 1000,
          wsEnabled: deps.isWsEnabled(),
          wsConnected: deps.getWsClient()?.connected ?? false,
          wsUrl: deps.getWsUrl() || null,
          caches: {
            associationGraph: 0,
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
        let body = '';
        let bodySize = 0;
        const MAX_BODY_SIZE = 64 * 1024;
        req.on('data', chunk => {
          bodySize += chunk.length;
          if (bodySize > MAX_BODY_SIZE) {
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('end', async () => {
          try {
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
              } catch { /* 非关键路径 */ }
            }
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ok ? { success: true } : { error: '规则不存在' }));
          } catch {
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
