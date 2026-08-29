/**
 * In-memory stand-in for the three commands {@link RedisEventStoreClient}
 * uses. Faithful about the parts the adapter depends on: entry ordering,
 * inclusive and exclusive `XRANGE` bounds, and key expiry.
 */
import type { RedisEventStoreClient } from '../index.js';

type Entry = { id: string; message: Record<string, string> };

/** Redis stream ids are `<ms>-<seq>`; compare them numerically, not as text. */
function compare(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  return Number(aMs) - Number(bMs) || Number(aSeq) - Number(bSeq);
}

export class FakeRedis implements RedisEventStoreClient {
  private readonly streams = new Map<string, Entry[]>();
  private readonly expiresAt = new Map<string, number>();
  private seq = 0;
  /** Milliseconds added to `Date.now()`, so tests can walk past a TTL. */
  offsetMs = 0;

  private now(): number {
    return Date.now() + this.offsetMs;
  }

  private live(key: string): Entry[] | undefined {
    const expiry = this.expiresAt.get(key);
    if (expiry !== undefined && expiry <= this.now()) {
      this.streams.delete(key);
      this.expiresAt.delete(key);
      return undefined;
    }
    return this.streams.get(key);
  }

  /** Keys currently holding data, for asserting on the layout. */
  keys(): string[] {
    return [...this.streams.keys()].filter((k) => this.live(k) !== undefined);
  }

  ttlOf(key: string): number | undefined {
    const expiry = this.expiresAt.get(key);
    return expiry === undefined ? undefined : expiry - this.now();
  }

  async xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
  ): Promise<string> {
    const entries = this.live(key) ?? [];
    const entryId = id === '*' ? `${this.now()}-${this.seq++}` : id;
    entries.push({ id: entryId, message });
    this.streams.set(key, entries);
    return entryId;
  }

  async xRange(key: string, start: string, end: string): Promise<Entry[]> {
    const entries = this.live(key) ?? [];
    const exclusive = start.startsWith('(');
    const lo = exclusive ? start.slice(1) : start;
    return entries.filter((e) => {
      if (lo !== '-') {
        const d = compare(e.id, lo);
        if (d < 0 || (exclusive && d === 0)) return false;
      }
      return end === '+' || compare(e.id, end) <= 0;
    });
  }

  async pExpire(key: string, ms: number): Promise<boolean> {
    if (!this.streams.has(key)) return false;
    this.expiresAt.set(key, this.now() + ms);
    return true;
  }
}
