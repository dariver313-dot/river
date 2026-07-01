/**
 * 自动回复 — 串联 onMessage → DeepSeek → sendText
 *
 * 流程:
 *   1. QXDim.onMessage 收到消息
 *   2. 过滤: 只回复单聊 + 文本 + 非自己 + 非系统通知
 *   3. 消息去重 (messageId 缓存)
 *   4. 速率控制 (同一用户 3 秒内只处理 1 条)
 *   5. 添加到对话历史 (ConversationStore)
 *   6. 调 DeepSeek API (带历史)
 *   7. 添加 AI 回复到历史
 *   8. sendText 回复用户
 *   9. 错误时发送 "服务暂时不可用"
 */

import { chatCompletion } from './deepseek-client.js';
import { ConversationStore } from './conversation-store.js';
import { logger } from '../utils/logger.js';

export class AutoReplyBot {
  /**
   * @param {object} options
   * @param {string} options.apiKey - DeepSeek API key
   * @param {string} options.myUserId - 自己的 userId (用于过滤自己发的消息)
   * @param {string} [options.systemPrompt='你是企讯达客服，回答用户问题'] - 系统提示词
   * @param {string} [options.model='deepseek-chat']
   * @param {number} [options.maxTokens=1000]
   * @param {number} [options.temperature=0.7]
   * @param {number} [options.maxHistoryPerUser=20] - 每用户对话历史
   * @param {number} [options.rateLimitMs=3000] - 同用户回复间隔
   * @param {boolean} [options.persistHistory=false] - 对话历史持久化
   * @param {string} [options.errorReply='服务暂时不可用，请稍后再试。']
   */
  constructor(options) {
    this.apiKey = options.apiKey;
    this.myUserId = options.myUserId;
    this.systemPrompt = options.systemPrompt || '你是企讯达客服，回答用户问题';
    this.model = options.model || 'deepseek-chat';
    this.maxTokens = options.maxTokens || 1000;
    this.temperature = options.temperature ?? 0.7;
    this.errorReply = options.errorReply || '服务暂时不可用，请稍后再试。';

    this.conversationStore = new ConversationStore({
      maxHistoryPerUser: options.maxHistoryPerUser || 20,
      persist: options.persistHistory || false,
    });

    /** @type {Map<string, number>} 用户最后回复时间（速率控制） */
    this.lastReplyTime = new Map();
    this.rateLimitMs = options.rateLimitMs || 3000;
    /** lastReplyTime Map 最大用户数（防止内存无限增长） */
    this.maxTrackedUsers = options.maxTrackedUsers || 10000;

    /** @type {Set<string>} 已处理的 messageId（去重） */
    this.processedMessageIds = new Set();
    this.maxProcessedCacheSize = 1000;

    /** 正在处理中的用户（防止并发） */
    this.processingUsers = new Set();

    // 统计
    this.stats = {
      received: 0,
      processed: 0,
      replied: 0,
      errors: 0,
      skipped: 0,
    };
    // ★ 跳过原因细分
    this.skipReasons = {
      nonSingleChat: 0,      // conversation.type !== 0
      selfMessage: 0,        // fromUserId === myUserId
      systemNotification: 0, // fromUserId 为空或 system_notification
      nonText: 0,            // 非文本消息（无 searchableContent）
      duplicate: 0,          // messageId 去重
      rateLimit: 0,          // 速率控制
      concurrent: 0,         // 并发处理中
    };
    // ★ 诊断: 记录最近跳过的消息样本（每种跳过原因取前2条）
    this._skipSamples = {};
  }

  /**
   * ★ 记录跳过原因样本（每种原因最多保留 2 条）
   */
  _recordSkipSample(reason, msg) {
    if (!this._skipSamples[reason]) this._skipSamples[reason] = [];
    if (this._skipSamples[reason].length < 2) {
      this._skipSamples[reason].push({
        fromUserId: msg.fromUserId,
        conversationType: msg.conversation?.type,
        text: (msg.text || '').substring(0, 40),
        messageId: msg.messageId,
        content: msg.content ? {
          type: msg.content.type,
          searchableContent: (msg.content.searchableContent || '').substring(0, 40),
          pushContent: (msg.content.pushContent || '').substring(0, 40),
          mediaType: msg.content.mediaType,
        } : null,
      });
    }
  }

  /**
   * 处理收到的消息（应注册为 QXDim.onMessage 回调）
   * @param {object} msg - ReceivedMessage
   * @param {object} qxd - QXDim 实例（用于发送回复）
   */
  async handleMessage(msg, qxd) {
    this.stats.received++;

    // 1. 过滤: 只回复单聊
    if (msg.conversation?.type !== 0) {
      this.stats.skipped++;
      this.skipReasons.nonSingleChat++;
      this._recordSkipSample('nonSingleChat', msg);
      return;
    }

    // 2. 过滤: 跳过自己发的
    if (msg.fromUserId === this.myUserId) {
      this.stats.skipped++;
      this.skipReasons.selfMessage++;
      this._recordSkipSample('selfMessage', msg);
      return;
    }

    // 3. 过滤: 跳过系统通知
    if (msg.fromUserId === 'system_notification' || !msg.fromUserId) {
      this.stats.skipped++;
      this.skipReasons.systemNotification++;
      this._recordSkipSample('systemNotification', msg);
      return;
    }

    // 4. 过滤: 只回复文本消息（暂不处理图片/视频/文件等）
    // msg.content.type = 1 表示文本
    if (!msg.text || msg.text.trim() === '') {
      this.stats.skipped++;
      this.skipReasons.nonText++;
      this._recordSkipSample('nonText', msg);
      return;
    }

    // 5. 去重: 同一 messageId 只处理一次
    if (this.processedMessageIds.has(msg.messageId)) {
      this.stats.skipped++;
      this.skipReasons.duplicate++;
      return;
    }

    const userId = msg.fromUserId;
    const userText = msg.text.trim();

    // 6. 速率控制: 同一用户 rateLimitMs 内只处理 1 条
    const lastTime = this.lastReplyTime.get(userId) || 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < this.rateLimitMs) {
      logger.debug(`[AutoReply] ⏭️ 速率限制: ${userId} 最近 ${elapsed}ms 内已回复，跳过`);
      this.stats.skipped++;
      this.skipReasons.rateLimit++;
      return;
    }

    // 7. 防止并发: 同一用户正在处理中则跳过
    if (this.processingUsers.has(userId)) {
      logger.debug(`[AutoReply] ⏭️ ${userId} 正在处理中，跳过`);
      this.stats.skipped++;
      this.skipReasons.concurrent++;
      return;
    }

    // 所有检查通过，正式标记为已处理
    this.processedMessageIds.add(msg.messageId);
    // 清理过期缓存（防止内存泄漏）
    if (this.processedMessageIds.size > this.maxProcessedCacheSize) {
      const toRemove = this.processedMessageIds.size - this.maxProcessedCacheSize / 2;
      const it = this.processedMessageIds.values();
      for (let i = 0; i < toRemove; i++) {
        this.processedMessageIds.delete(it.next().value);
      }
    }

    // 淘汰最久未活跃用户（防止 Map 无限增长）
    // ★ lastReplyTime 在 finally 块统一更新，此处仅做容量管理
    if (this.lastReplyTime.size > this.maxTrackedUsers) {
      // Map 保持插入顺序，第一个是最老的
      const oldestKey = this.lastReplyTime.keys().next().value;
      this.lastReplyTime.delete(oldestKey);
    }

    this.processingUsers.add(userId);
    this.stats.processed++;

    logger.debug(`\n[AutoReply] 📨 来自 ${userId}: "${userText.substring(0, 80)}"`);

    try {
      // 8. 添加用户消息到对话历史
      await this.conversationStore.addMessage(userId, 'user', userText);

      // 9. 构造 DeepSeek 请求
      const history = await this.conversationStore.getHistory(userId);
      const messages = [
        { role: 'system', content: this.systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ];

      logger.debug(`[AutoReply] 🤖 调用 DeepSeek (历史 ${history.length} 条)...`);
      const result = await chatCompletion({
        apiKey: this.apiKey,
        messages,
        model: this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
      });

      const reply = result.content.trim();
      logger.debug(`[AutoReply] ✅ AI 回复: "${reply.substring(0, 80)}..."`);
      logger.debug(`[AutoReply]   tokens: ${result?.usage?.total_tokens ?? 0} (prompt=${result?.usage?.prompt_tokens ?? 0}, completion=${result?.usage?.completion_tokens ?? 0})`);

      // 10. 添加 AI 回复到历史
      await this.conversationStore.addMessage(userId, 'assistant', reply);

      // 11. 发送回复
      await qxd.sendText(userId, reply);
      this.stats.replied++;

      logger.debug(`[AutoReply] 📤 已回复 ${userId}`);
    } catch (e) {
      this.stats.errors++;
      logger.error(`[AutoReply] ❌ 处理失败: ${e.message}`);
      // 发送错误回复
      try {
        await qxd.sendText(userId, this.errorReply);
      } catch (e2) {
        logger.error(`[AutoReply] ❌ 错误回复也失败: ${e2.message}`);
      }
    } finally {
      // ★ 无论成功或失败都更新 lastReplyTime，防止失败时速率限制被绕过
      this.lastReplyTime.set(userId, Date.now());
      this.processingUsers.delete(userId);
    }
  }

  /**
   * 获取统计信息
   * @returns {Promise<object>}
   */
  async getStats() {
    return {
      ...this.stats,
      skipReasons: { ...this.skipReasons },
      activeUsers: (await this.conversationStore.listUsers()).length,
      processingCount: this.processingUsers.size,
    };
  }

  /**
   * 清除指定用户的对话历史
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async clearUserHistory(userId) {
    await this.conversationStore.clear(userId);
    this.lastReplyTime.delete(userId);
    logger.debug(`[AutoReply] 已清除 ${userId} 的对话历史`);
  }

  /**
   * 清除所有用户的对话历史
   * @returns {Promise<void>}
   */
  async clearAllHistory() {
    await this.conversationStore.clearAll();
    this.lastReplyTime.clear();
    logger.debug('[AutoReply] 已清除所有对话历史');
  }
}

export default AutoReplyBot;
