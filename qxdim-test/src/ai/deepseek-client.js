/**
 * DeepSeek API 客户端
 *
 * DeepSeek 兼容 OpenAI Chat Completions 格式:
 *   POST https://api.deepseek.com/v1/chat/completions
 *   Authorization: Bearer <API_KEY>
 *   body: { model, messages, max_tokens, temperature, stream }
 *
 * 模型:
 *   - deepseek-chat: 通用对话（V3）
 *   - deepseek-reasoner: 推理模型（R1）
 */

import https from 'https';
import { URL } from 'url';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT = 30000;
// ★ 重试配置: 瞬时错误（5xx/429/网络错误）自动重试
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

// ★ Keep-alive agent: 复用 TCP/TLS 连接，避免每次请求都握手
//   maxSockets 充足，keepAlive=true，keepAliveMsecs=30s
const _httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: DEFAULT_TIMEOUT,
});

/**
 * 判断错误是否可重试（瞬时错误）
 * - 网络错误（ECONNRESET/ETIMEDOUT/ECONNREFUSED/EAI_AGAIN）
 * - HTTP 429（限流）
 * - HTTP 5xx（服务器错误）
 */
function _isRetryableError(error, statusCode) {
  if (error) {
    const code = error.code || '';
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'].includes(code)) {
      return true;
    }
  }
  if (statusCode && (statusCode === 429 || (statusCode >= 500 && statusCode < 600))) {
    return true;
  }
  return false;
}

/**
 * 调用 DeepSeek Chat Completions
 *
 * @param {object} options
 * @param {string} options.apiKey - DeepSeek API key
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} options.messages - 对话历史
 * @param {string} [options.model='deepseek-chat'] - 模型名
 * @param {number} [options.maxTokens=1000] - 最大输出 token
 * @param {number} [options.temperature=0.7] - 温度 (0-2)
 * @param {string} [options.baseUrl] - API base URL
 * @param {number} [options.timeout=30000] - 超时毫秒
 * @param {number} [options.maxRetries=2] - 瞬时错误最大重试次数
 * @returns {Promise<{content: string, usage: {prompt_tokens: number, completion_tokens: number, total_tokens: number}, model: string, finishReason: string}>}
 */
export async function chatCompletion(options) {
  const {
    apiKey,
    messages,
    model = DEFAULT_MODEL,
    maxTokens = 1000,
    temperature = 0.7,
    baseUrl = DEFAULT_BASE_URL,
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  if (!apiKey) {
    throw new Error('[DeepSeek] apiKey 不能为空');
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('[DeepSeek] messages 不能为空');
  }

  const url = `${baseUrl}/v1/chat/completions`;
  const body = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  });

  // ★ 重试循环: 瞬时错误自动重试，指数退避
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await _doRequest(url, body, apiKey, timeout, model);
      return result;
    } catch (e) {
      lastError = e;
      // 检查是否可重试
      const statusCode = e._statusCode;
      if (!_isRetryableError(e, statusCode) || attempt >= maxRetries) {
        throw e;
      }
      // 指数退避: 1s → 2s → 4s（加抖动）
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * 实际发送 HTTP 请求（单次，不重试）
 */
function _doRequest(url, body, apiKey, timeout, model) {
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

    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      agent: _httpsAgent,  // ★ keep-alive agent
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      // ★ 监听响应流 error: socket 在响应阶段出错时触发，防止 Promise 挂起
      res.on('error', safeReject);
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          let errMsg = `HTTP ${res.statusCode}`;
          try {
            const errJson = JSON.parse(respBody);
            errMsg += `: ${errJson.error?.message || errJson.message || respBody.substring(0, 200)}`;
          } catch {
            errMsg += `: ${respBody.substring(0, 200)}`;
          }
          const err = new Error(`[DeepSeek] ${errMsg}`);
          err._statusCode = res.statusCode;  // ★ 标记状态码供重试逻辑判断
          safeReject(err);
          return;
        }
        try {
          const data = JSON.parse(respBody);
          const choice = data.choices?.[0];
          if (!choice) {
            safeReject(new Error('[DeepSeek] 响应无 choices'));
            return;
          }
          safeResolve({
            content: choice.message?.content || '',
            usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            model: data.model || model,
            finishReason: choice.finish_reason || 'stop',
          });
        } catch (e) {
          safeReject(new Error(`[DeepSeek] 解析响应失败: ${e.message}`));
        }
      });
    });

    req.on('error', safeReject);
    req.setTimeout(timeout, () => {
      req.destroy();
      const err = new Error(`[DeepSeek] 请求超时 (${timeout}ms)`);
      err.code = 'ETIMEDOUT';  // ★ 标记为可重试
      safeReject(err);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 简单对话（无历史，单轮）
 */
export async function chat(apiKey, systemPrompt, userMessage, options = {}) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });
  const result = await chatCompletion({ apiKey, messages, ...options });
  return result.content;
}

export default { chatCompletion, chat };
