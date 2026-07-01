import { logger } from './logger';
import { dbHolder } from './db';

function parseEnvList(key: string, defaults: string[]): string[] {
  const raw = process.env[key];
  if (raw !== undefined && raw.trim() !== '') {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return defaults;
}

// 代理白名单不再硬编码默认值，统一由 .env (AGENT_WHITELIST) 或数据库配置
const DEFAULT_AGENT_WHITELIST: string[] = [];

const _envAgentWhitelist = parseEnvList('AGENT_WHITELIST', DEFAULT_AGENT_WHITELIST);

const _agentWhitelist = new Set<string>(_envAgentWhitelist);

/**
 * 代理白名单（只读语义，外部不应直接修改）。
 * 需要更新白名单请通过 `reloadConstantsFromDB()` 或设置 .env `AGENT_WHITELIST`。
 */
export const AGENT_WHITELIST: ReadonlySet<string> = _agentWhitelist;

/** 从数据库重新加载白名单配置，DB 无配置时保留 .env 值 */
export async function reloadConstantsFromDB(): Promise<void> {
  try {
    const config = await dbHolder.db.botConfig.findUnique({ where: { key: 'AGENT_WHITELIST' } }).catch(() => null);

    const wl = config?.value;
    if (wl) {
      const items = wl.split(',').map(s => s.trim()).filter(Boolean);
      if (items.length > 0) {
        _agentWhitelist.clear();
        for (const v of items) _agentWhitelist.add(v);
      }
    }

    logger.info({ count: _agentWhitelist.size }, '[配置] 白名单/代理配置已从数据库加载');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[配置] 从数据库加载白名单失败，使用环境变量配置');
  }
}
