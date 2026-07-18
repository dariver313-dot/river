import fs from 'fs';
import path from 'path';

export interface IdempotencyEntry {
  result?: unknown;
  timestamp: number;
  pending?: boolean;
  requestHash: string;
  statusCode?: number;
}

interface LegacyStoreFile {
  version: 1;
  entries: Record<string, IdempotencyEntry>;
}

type JournalRecord =
  | { version: 1; op: 'set'; key: string; entry: IdempotencyEntry }
  | { version: 1; op: 'delete'; key: string };

/**
 * Durable append-only idempotency journal.
 * Financial requests are synced before reaching the upstream API; periodic
 * compaction keeps write cost stable as the number of retained keys grows.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private mutationsSinceCompact = 0;

  constructor(filePath: string, ttlMs: number, maxEntries: number) {
    this.filePath = path.resolve(filePath);
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.load();
    this.cleanup();
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: IdempotencyEntry): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      this.cleanup();
      if (this.entries.size >= this.maxEntries) throw new Error('幂等存储已达到容量上限');
    }

    const previous = this.entries.get(key);
    this.entries.set(key, entry);
    try {
      this.append({ version: 1, op: 'set', key, entry });
    } catch (error) {
      if (previous) this.entries.set(key, previous);
      else this.entries.delete(key);
      throw error;
    }
  }

  delete(key: string): void {
    const previous = this.entries.get(key);
    if (!previous) return;
    this.entries.delete(key);
    try {
      this.append({ version: 1, op: 'delete', key });
    } catch (error) {
      this.entries.set(key, previous);
      throw error;
    }
  }

  /** A pending entry loaded after a process restart has an unknown upstream result. */
  recoverPending(result: unknown, statusCode: number): number {
    let recovered = 0;
    for (const [key, entry] of this.entries) {
      if (!entry.pending) continue;
      this.entries.set(key, { ...entry, pending: false, result, statusCode });
      recovered++;
    }
    if (recovered > 0) this.compact();
    return recovered;
  }

  cleanup(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (now - entry.timestamp > this.ttlMs) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.compact();
  }

  private ensureDirectory(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  private append(record: JournalRecord): void {
    this.ensureDirectory();
    const fd = fs.openSync(this.filePath, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.mutationsSinceCompact++;
    if (this.mutationsSinceCompact >= Math.max(1000, this.entries.size * 4)) this.compact();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return;

    // Migrate the earlier single-JSON format without discarding protection data.
    try {
      const legacy = JSON.parse(raw) as LegacyStoreFile;
      if (legacy.version === 1 && legacy.entries && typeof legacy.entries === 'object') {
        this.loadEntries(legacy.entries);
        this.compact();
        return;
      }
    } catch {
      // Expected for the append-only journal format.
    }

    const lines = raw.split('\n');
    let repairNeeded = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line) as JournalRecord;
        if (record.version !== 1 || typeof record.key !== 'string') throw new Error('记录格式无效');
        if (record.op === 'set' && this.validEntry(record.entry)) this.entries.set(record.key, record.entry);
        else if (record.op === 'delete') this.entries.delete(record.key);
        else throw new Error('记录操作无效');
      } catch (error) {
        // A crash may leave only the final append incomplete; earlier corruption is unsafe.
        const isLastNonEmpty = lines.slice(index + 1).every(item => item.trim() === '');
        if (!isLastNonEmpty) throw new Error(`幂等日志损坏（第 ${index + 1} 行）: ${this.filePath}`);
        repairNeeded = true;
      }
    }
    if (repairNeeded) this.compact();
  }

  private loadEntries(entries: Record<string, IdempotencyEntry>): void {
    for (const [key, entry] of Object.entries(entries)) {
      if (this.validEntry(entry)) this.entries.set(key, entry);
    }
  }

  private validEntry(entry: IdempotencyEntry | undefined): entry is IdempotencyEntry {
    return Boolean(entry && typeof entry.timestamp === 'number' && typeof entry.requestHash === 'string');
  }

  private compact(): void {
    this.ensureDirectory();
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    const content = Array.from(this.entries, ([key, entry]) => JSON.stringify({
      version: 1,
      op: 'set',
      key,
      entry,
    } satisfies JournalRecord)).join('\n');
    fs.writeFileSync(tempPath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    this.mutationsSinceCompact = 0;
  }
}
