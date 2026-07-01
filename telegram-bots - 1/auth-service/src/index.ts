/**
 * Auth Service 启动入口
 */

import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import express from 'express';
import { tokenManager } from './token-manager';
import { performAutoLogin, type AutoLoginConfig } from './auto-login';
import { performPlatformBLogin, type PlatformBLoginConfig } from './auto-login-b';
import { clearSm4Cache } from './sm4-crypto';
import { setLogtoken } from './platforms/platform-a';
import { env } from './crypto-utils';
import apiRouter from './api';

import http from 'http';

const PORT = parseInt(process.env.PORT || '3100', 10);
const USE_HTTPS = !!(process.env.HTTPS_KEY_PATH && process.env.HTTPS_CERT_PATH);
const app = express();

let activeServer: http.Server | null = null;

app.use(express.json({ limit: '2mb' }));

// 请求关联 ID（跨服务追踪）
app.use((req, _res, next) => {
  (req as any)._requestId = (req.headers['x-request-id'] as string)
    || crypto.randomBytes(8).toString('hex');
  next();
});

// 安全响应头
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (USE_HTTPS) {
    // 仅在启用 HTTPS 时设置 HSTS
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// API 路由
app.use('/api', apiRouter);

// 根路径健康检查（带 Token 状态信号，不暴露详情）
app.get('/', (_req, res) => {
  const status = tokenManager.getStatus();
  const tokens: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(status)) {
    tokens[k] = (v as any).hasToken;
  }
  const allHealthy = Object.values(tokens).every(Boolean) && Object.keys(tokens).length > 0;
  res.json({
    service: 'auth-service',
    status: allHealthy ? 'healthy' : 'degraded',
    tokens,
  });
});

// ============================================================
// 启动时自动登录
// ============================================================

function getAutoLoginConfig(): AutoLoginConfig | null {
  const account = env('AUTO_LOGIN_ACCOUNT');
  const password = env('AUTO_LOGIN_PASSWORD');
  const totpSecret = env('AUTO_LOGIN_TOTP_SECRET');
  const rsaPublicKey = env('RSA_PUBLIC_KEY');
  const baseUrl = env('PLATFORM_A_BASE_URL');

  if (!account || !password || !totpSecret || !rsaPublicKey || !baseUrl) return null;

  return { baseUrl, account, password, totpSecret, rsaPublicKey };
}

async function bootstrap(): Promise<void> {
  console.log('[启动] Auth Service 正在启动...');

  // ----------------------------------------------------------
  // 启动前配置校验
  // ----------------------------------------------------------
  const warnings: string[] = [];

  if (!getAutoLoginConfig()) {
    warnings.push('平台A 自动登录未配置，Token 需手动通过 /api/platform-a/setToken 设置');
  }
  if (!env('PLATFORM_B_LOGIN_ACCOUNT') || !env('PLATFORM_B_LOGIN_PASSWORD')) {
    if (env('PLATFORM_B_ROBOT_BASE_URL')) {
      warnings.push('平台B 自动登录未配置，Token 需手动通过 /api/platform-b/setToken 设置');
    }
  }
  if (!env('BOT_API_KEYS')) {
    warnings.push('BOT_API_KEYS 未配置，所有 API 请求将被 403 拒绝');
  }
  if (!env('BOT_FINANCE_KEYS')) {
    warnings.push('BOT_FINANCE_KEYS 未配置，加款操作将被 403 拒绝');
  }
  if (!env('BOT_ADMIN_KEYS')) {
    warnings.push('BOT_ADMIN_KEYS 未配置，setToken/status 操作将被 403 拒绝');
  }

  if (warnings.length > 0) {
    console.warn('[启动] ⚠ 配置警告:');
    warnings.forEach(w => console.warn(`  - ${w}`));
  }

  // 平台A 自动登录
  const autoLoginConfig = getAutoLoginConfig();
  if (autoLoginConfig) {
    console.log('[启动] 检测到平台A自动登录配置，正在登录...');
    try {
      const result = await performAutoLogin(autoLoginConfig);
      if (result?.token) {
        tokenManager.setToken('platform_a', result.token, result.expiresInMs);
        // 存储 logtoken，后续请求 Cookie 需要携带
        setLogtoken(result.accessLogToken || '');
        console.log('[启动] 平台A 自动登录成功');
        // 刷新间隔：TTL 的 50%，确保在过期前刷新；12h TTL → 6h 刷新
        const refreshInterval = result.expiresInMs
          ? Math.floor(result.expiresInMs * 0.5)
          : undefined;
        tokenManager.startAutoRefresh('platform_a', autoLoginConfig, refreshInterval);
      } else {
        console.warn('[启动] 平台A 自动登录失败');
      }
    } catch (e: any) {
      const safeMsg = (e.message || '').replace(/([?&])(account|password|code)=[^&\s]*/gi, '$1$2=***');
      console.error(`[启动] 平台A 自动登录异常: ${safeMsg}`);
    }
  } else {
    console.log('[启动] 未配置平台A自动登录，Token 需要手动设置');
  }

  // 平台B 自动登录
  const bAccount = env('PLATFORM_B_LOGIN_ACCOUNT');
  const bPassword = env('PLATFORM_B_LOGIN_PASSWORD');
  const bTotpSecret = env('PLATFORM_B_TOTP_SECRET');
  const bBaseUrl = env('PLATFORM_B_RISK_BASE_URL');

  if (bAccount && bPassword && bTotpSecret && bBaseUrl) {
    console.log('[启动] 检测到平台B自动登录配置，正在登录...');
    try {
      const bConfig: PlatformBLoginConfig = {
        platform: 'b',
        baseUrl: bBaseUrl,
        account: bAccount,
        password: bPassword,
        totpSecret: bTotpSecret,
        tenantCode: env('PLATFORM_B_TENANT_CODE') || 'CSZH',
      };
      if (!env('PLATFORM_B_TENANT_CODE')) {
        console.log('[启动] 平台B 租户代码未配置，使用默认值: CSZH');
      }
      const bResult = await performPlatformBLogin(bConfig);
      if (bResult?.token) {
        tokenManager.setToken('platform_b', bResult.token, bResult.estimatedTtlMs);
        console.log('[启动] 平台B 自动登录成功');
        // 刷新间隔：TTL 的 50%，确保在过期前刷新；12h TTL → 6h 刷新
        const refreshInterval = bResult.estimatedTtlMs
          ? Math.floor(bResult.estimatedTtlMs * 0.5)
          : undefined;
        tokenManager.startAutoRefresh('platform_b', bConfig, refreshInterval, () => { clearSm4Cache(); });
      } else {
        console.warn('[启动] 平台B 自动登录失败');
      }
    } catch (e: any) {
      const safeMsg = (e.message || '').replace(/([?&])(account|password|code|googleCode)=[^&\s]*/gi, '$1$2=***');
      console.error(`[启动] 平台B 自动登录异常: ${safeMsg}`);
    }
  } else if (env('PLATFORM_B_ROBOT_BASE_URL')) {
    console.log('[启动] 平台B 未配置自动登录，Token 需要手动设置');
  } else {
    console.log('[启动] 未配置平台B，跳过');
  }

  // 启动 HTTP/HTTPS 服务
  const protocol = USE_HTTPS ? 'https' : 'http';

  if (USE_HTTPS) {
    const keyPath = process.env.HTTPS_KEY_PATH!;
    const certPath = process.env.HTTPS_CERT_PATH!;
    if (!fs.existsSync(keyPath)) {
      console.error(`[启动失败] HTTPS 密钥文件不存在: ${keyPath}`);
      process.exit(1);
    }
    if (!fs.existsSync(certPath)) {
      console.error(`[启动失败] HTTPS 证书文件不存在: ${certPath}`);
      process.exit(1);
    }
    const httpsServer = https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }, app);
    activeServer = httpsServer;
    httpsServer.listen(PORT, () => {
      console.log(`[启动] Auth Service 已启动，端口: ${PORT} (${protocol.toUpperCase()})`);
    });
  } else {
    activeServer = app.listen(PORT, () => {
      console.log(`[启动] Auth Service 已启动，端口: ${PORT} (${protocol.toUpperCase()})`);
    });
  }
}

// 优雅退出（等待进行中请求完成，最长 30 秒后强制关闭）
function gracefulShutdown(signal: string): void {
  console.log(`\n[退出] 收到 ${signal}，正在关闭...`);
  tokenManager.stopAll();

  if (activeServer) {
    activeServer.close(() => {
      console.log('[退出] 服务已关闭');
      process.exit(0);
    });
    // 超时保护：30 秒后强制退出
    setTimeout(() => {
      console.error('[退出] 强制关闭（超时）');
      process.exit(1);
    }, 30000);
  } else {
    process.exit(0);
  }
}

// 优雅退出
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

bootstrap().catch((err) => {
  const safeMsg = (err?.message || String(err)).replace(/([?&])(account|password|code|token)=[^&\s]*/gi, '$1$2=***');
  console.error(`[启动失败] ${safeMsg.slice(0, 200)}`);
  process.exit(1);
});
