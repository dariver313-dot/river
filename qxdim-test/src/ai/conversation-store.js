/**
 * 对话历史管理 — 每个用户独立上下文
 *
 * 默认内存存储（进程重启后丢失），可选文件持久化。
 * 每个用户最多保留 maxHistoryPerUser 轮对话（1 轮 = 1 user + 1 assistant）。
 *
 * 注意：持久化模式下所有 I/O 均为异步，调用方需 await。
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_DIR = path.join(__dirname, '..', '..', 'config', 'conversations');

export class ConversationStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxHistoryPerUser=20] - 每用户最大消息数（含 user+assistant）
   * @param {boolean} [options.persist=false] - 是否持久化到文件
   * @param {string} [options.storageDir] - 持久化目录
   */
  constructor(options = {}) {
    this.maxHistoryPerUser = options.maxHistoryPerUser || 20;
    this.persist = options.persist || false;
    this.storageDir = options.storageDir || DEFAULT_STORAGE_DIR;
    /** conversations Map 最大用户数（防止内存无限增长，仅非持久化模式生效） */
    this.maxUsers = options.maxUsers || 10000;
    /** @type {Map<string, Array<{role: string, content: string, timestamp: number}>>} */
    this.conversations = new Map();
    /** 持久化模式下每用户的写锁（pending Promise），防止 read-modify-write 竞态 */
    this._writeLocks = new Map();

    if (this.persist) {
      // 一次性初始化，目录通常已存在；保留同步调用以简化构造器
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    }
  }

  /**
   * 获取用户的对话历史
   * @param {string} userId
   * @returns {Promise<Array<{role: string, content: string}>>}
   */
  async getHistory(userId) {
    if (this.persist) {
      return this._loadFromFile(userId);
    }
    const history = this.conversations.get(userId);
    if (history) {
      // ★ LRU 提升: delete + re-set 将 key 移到 Map 末尾，保护活跃用户不被淘汰
      this.conversations.delete(userId);
      this.conversations.set(userId, history);
    }
    return history || [];
  }

  /**
   * 添加一条消息到用户的历史
   * @param {string} userId
   * @param {string} role - 'user' | 'assistant' | 'system'
   * @param {string} content
   * @returns {Promise<void>}
   */
  async addMessage(userId, role, content) {
    const message = { role, content, timestamp: Date.now() };

    // 非持久化模式：写入内存 Map，并淘汰最久未活跃用户
    if (!this.persist) {
      let history = this.conversations.get(userId);
      if (!history) {
        history = [];
        this.conversations.set(userId, history);
        // 超过最大用户数时淘汰最老的（Map 保持插入顺序）
        if (this.conversations.size > this.maxUsers) {
          const oldestKey = this.conversations.keys().next().value;
          this.conversations.delete(oldestKey);
        }
      }
      history.push(message);
      // 限制每用户历史长度
      if (history.length > this.maxHistoryPerUser) {
        history.splice(0, history.length - this.maxHistoryPerUser);
      }
      return;
    }

    // 持久化模式：读写文件（加写锁防止并发 read-modify-write 竞态丢消息）
    // ★ 关键: 用 .catch(() => {}) 吞掉前一次写入的 rejection，
    //   否则前一次失败会阻断链上所有后续写入（它们都会 skip callback 直接 reject）
    const prev = (this._writeLocks.get(userId) || Promise.resolve()).catch(() => {});
    const next = prev.then(async () => {
      const history = await this._loadFromFile(userId);
      history.push(message);
      const trimmed = this._trim(history);
      await this._saveToFile(userId, trimmed);
    });
    this._writeLocks.set(userId, next);
    // 写完后清理锁引用（避免 Map 无限增长），但保留最后一个 pending 的
    // 注意: 这里用独立的 .then/.catch 链，不影响返回给调用者的 next promise
    next.then(() => {
      if (this._writeLocks.get(userId) === next) {
        this._writeLocks.delete(userId);
      }
    }).catch(() => {
      // 写入失败: 仅当当前锁仍是本 Promise 时删除，防止误删更新链上的新锁
      if (this._writeLocks.get(userId) === next) {
        this._writeLocks.delete(userId);
      }
    });
    return next;
  }

  /**
   * 清除用户的对话历史
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async clear(userId) {
    if (this.persist) {
      // ★ 等待该用户所有 pending 写入完成，再删除文件
      //   否则 pending 写入会在 clear 之后重新创建文件，导致 clear 失效
      const pending = this._writeLocks.get(userId);
      if (pending) {
        try { await pending; } catch (e) { /* 忽略写入错误，继续清除 */ }
      }
      const file = this._getFilePath(userId);
      try {
        await fsp.unlink(file);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      // 清除后删除锁引用，确保后续 addMessage 从全新链开始
      this._writeLocks.delete(userId);
    } else {
      this.conversations.delete(userId);
    }
  }

  /**
   * 清除所有用户的历史
   * @returns {Promise<void>}
   */
  async clearAll() {
    if (this.persist) {
      // ★ 等待所有 pending 写入完成，再批量删除文件
      const pendingPromises = Array.from(this._writeLocks.values());
      if (pendingPromises.length > 0) {
        await Promise.allSettled(pendingPromises);
      }
      let files;
      try {
        files = await fsp.readdir(this.storageDir);
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      await Promise.all(jsonFiles.map(f => fsp.unlink(path.join(this.storageDir, f)).catch(() => {})));
      // 清除所有锁引用
      this._writeLocks.clear();
    } else {
      this.conversations.clear();
    }
  }

  /**
   * 列出所有有对话记录的用户
   * @returns {Promise<string[]>}
   */
  async listUsers() {
    if (this.persist) {
      let files;
      try {
        files = await fsp.readdir(this.storageDir);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    }
    return Array.from(this.conversations.keys());
  }

  // ============ 内部方法 ============

  _trim(history) {
    return history.length > this.maxHistoryPerUser
      ? history.slice(-this.maxHistoryPerUser)
      : history;
  }

  _getFilePath(userId) {
    // ★ 用 hash 替代字符删除，防止不同 userId（如 "user^1" 和 "user#1"）碰撞到同一文件
    //   前缀保留前 16 个安全字符用于人类识别，hash 取 16 位 hex 用于唯一性
    const prefix = String(userId).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 16);
    const hash = crypto.createHash('sha256').update(String(userId)).digest('hex').substring(0, 16);
    const safeUserId = prefix ? `${prefix}_${hash}` : hash;
    return path.join(this.storageDir, `${safeUserId}.json`);
  }

  async _loadFromFile(userId) {
    const file = this._getFilePath(userId);
    try {
      const text = await fsp.readFile(file, 'utf8');
      return JSON.parse(text);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      // ★ 非 ENOENT 错误（EACCES, EMFILE, 文件损坏等）：抛出错误，防止 _saveToFile 静默覆盖
      //   调用方 addMessage 会 catch 并让写锁 chain 失败，避免永久丢失对话历史
      if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EMFILE') {
        logger.error(`[ConversationStore] 无法读取 ${file} (${e.code}):`, e.message);
        throw e;
      }
      // JSON 损坏：记录警告后当作空历史，下次写入会覆盖（可恢复）
      logger.warn(`[ConversationStore] ${file} 文件损坏，当作空历史:`, e.message);
      return [];
    }
  }

  async _saveToFile(userId, history) {
    const file = this._getFilePath(userId);
    await fsp.writeFile(file, JSON.stringify(history, null, 2));
  }
}

export default ConversationStore;
