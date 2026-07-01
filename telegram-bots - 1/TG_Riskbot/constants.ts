import { logger } from './logger';
import { dbHolder } from './db';

function parseEnvList(key: string, defaults: string[]): string[] {
  const raw = process.env[key];
  if (raw !== undefined && raw.trim() !== '') {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return defaults;
}

// 默认白名单（硬编码兜底，.env / DB 配置优先）
const DEFAULT_AGENT_WHITELIST = [
  'xiaolin123', 'aa888', 'my666888', 'xx8888', 'SC98888', 'jiu972', 'yt123',
  'wang0909', 'an8888', 'an9999', 'wen1995', 'qq6988', 'zz6699', 'aini7788',
  'aan7788', 'my302',
];

// .env 覆盖默认值（优先级：DB > .env > 默认值）
const _envAgentWhitelist = parseEnvList('AGENT_WHITELIST', DEFAULT_AGENT_WHITELIST);

let _agentWhitelist = new Set<string>(_envAgentWhitelist);

export const AGENT_WHITELIST = _agentWhitelist;

/** 从数据库重新加载白名单配置，DB 无配置时保留默认值 */
export async function reloadConstantsFromDB(): Promise<void> {
  try {
    const config = await dbHolder.db.botConfig.findUnique({ where: { key: 'AGENT_WHITELIST' } }).catch(() => null);

    const wl = config?.value;
    if (wl) {
      const newSet = new Set(wl.split(',').map(s => s.trim()).filter(Boolean));
      if (newSet.size > 0) {
        _agentWhitelist.clear();
        for (const v of newSet) _agentWhitelist.add(v);
      }
    }

    logger.info('[配置] 白名单/代理配置已从数据库加载');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[配置] 从数据库加载白名单失败，使用默认值');
  }
}
