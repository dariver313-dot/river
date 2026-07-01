/**
 * HTTP 工具模块 — 提供per-request级别的 TLS 配置，避免全局副作用
 *
 * 问题: Node.js 内置 fetch() 不支持 per-request 的 rejectUnauthorized 配置，
 *       依赖 NODE_TLS_REJECT_UNAUTHORIZED=0 会禁用整个进程的 TLS 校验。
 * 方案: 用 https.Agent 实现 insecureFetch，仅对需要自签名证书的请求禁用校验。
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

// 共享的 insecure Agent（仅用于需要自签名证书的请求）
export const insecureHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// 默认超时 30s
const DEFAULT_TIMEOUT_MS = 30000;

/** 统一 User-Agent（模拟企讯达 PC 客户端） */
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) qxdim/1.14.28 Chrome/91.0.4472.164 Electron/13.6.9 Safari/537.36';

/** 默认最大响应体大小 (5 MB)，防止恶意/异常服务器导致 OOM */
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * 兼容 fetch API 的请求函数，支持 per-request TLS 配置
 *
 * @param {string} url - 请求 URL
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeout=30000] - 超时毫秒
 * @param {boolean} [options.insecure=false] - 是否禁用 TLS 证书校验（仅对自签名证书服务器开启）
 * @param {number} [options.maxResponseBytes=5242880] - 最大响应体大小 (默认 5 MB)，超限则拒绝
 * @returns {Promise<{ok, status, statusText, headers, text, json}>}
 */
export async function insecureFetch(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = DEFAULT_TIMEOUT_MS,
    insecure = false,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;

  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === 'https:';
  const requestModule = isHttps ? https : http;

  const requestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method,
    headers: { ...headers },
  };

  // 仅对 HTTPS 请求设置 agent
  if (isHttps && insecure) {
    requestOptions.agent = insecureHttpsAgent;
  }

  // ★ 统一 body 为 Buffer: Content-Length 用 bodyBuffer 计算，write 也用同一个 bodyBuffer
  const bodyBuffer = (body != null)
    ? (Buffer.isBuffer(body) ? body : Buffer.from(body))
    : null;
  if (bodyBuffer && !requestOptions.headers['Content-Length']) {
    requestOptions.headers['Content-Length'] = bodyBuffer.length;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const safeResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const req = requestModule.request(requestOptions, (res) => {
      const chunks = [];
      let totalBytes = 0;
      let sizeExceeded = false;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          sizeExceeded = true;
          req.destroy(new Error(`响应体过大 (${totalBytes} > ${maxResponseBytes} bytes): ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      // ★ 监听响应流 error: socket 在响应阶段出错（如 TLS 错误、连接重置）时触发
      //   不监听会导致 Promise 永久挂起（'end' 不会到达）
      res.on('error', safeReject);
      res.on('end', () => {
        if (sizeExceeded) return;  // req.destroy 已触发 safeReject
        const bodyBuffer = Buffer.concat(chunks);
        const bodyText = bodyBuffer.toString('utf8');

        // 构造 headers 包装器，兼容 fetch API 的 .get() 方法
        const responseHeaders = {
          _raw: res.headers,
          get(name) {
            const lower = name.toLowerCase();
            const val = res.headers[lower];
            return val != null ? (Array.isArray(val) ? val.join(', ') : String(val)) : null;
          },
        };

        safeResolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: responseHeaders,
          text: () => Promise.resolve(bodyText),
          json: () => new Promise((resolveJson, rejectJson) => {
            try { resolveJson(JSON.parse(bodyText)); } catch (e) { rejectJson(e); }
          }),
          buffer: () => Promise.resolve(bodyBuffer),
        });
      });
    });

    // 超时处理
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时 (${timeout}ms): ${url}`));
    });

    req.on('error', safeReject);

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

export default { insecureFetch, insecureHttpsAgent, USER_AGENT };
