import { buildLiveQuote, type GammaMarket, type LiveMarketQuote } from './polymarketApi';
import { log } from '../utils/logger';

const GAMMA_HOST    = process.env.POLYMARKET_GAMMA_HOST ?? 'https://gamma-api.polymarket.com';
const DEFAULT_TTL   = 3 * 60 * 1_000;   // 3 minutes — safe for 5-min and 15-min contracts

interface CacheEntry {
  quote:     LiveMarketQuote;
  expiresAt: number;
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const url = `${GAMMA_HOST}/markets?slug=${encodeURIComponent(slug)}&active=true&accepting_orders=true&limit=1`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Gamma API ${response.status} ${response.statusText} for slug="${slug}"`);
  }
  const data = (await response.json()) as GammaMarket | GammaMarket[];
  const market = Array.isArray(data) ? data[0] : data;
  return market ?? null;
}

export class TokenDiscoveryService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL) {
    this.ttlMs = ttlMs;
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() >= entry.expiresAt;
  }

  async resolveSlug(slug: string): Promise<LiveMarketQuote | null> {
    const cached = this.cache.get(slug);

    if (cached && !this.isExpired(cached)) {
      return cached.quote;
    }

    try {
      const market = await fetchMarketBySlug(slug);
      if (!market) {
        log('warn', `Token discovery: no active market for slug "${slug}".`);
        return cached?.quote ?? null;
      }

      const quote = await buildLiveQuote(market);
      if (!quote) {
        log('warn', `Token discovery: cannot build quote for slug "${slug}".`);
        return cached?.quote ?? null;
      }

      this.cache.set(slug, { quote, expiresAt: Date.now() + this.ttlMs });
      return quote;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('warn', `Token discovery failed for slug "${slug}" — using cached data.`, msg);
      return cached?.quote ?? null;
    }
  }

  async resolveAll(slugs: string[]): Promise<Map<string, LiveMarketQuote>> {
    const results = await Promise.allSettled(
      slugs.map(async (slug) => ({ slug, quote: await this.resolveSlug(slug) }))
    );

    const resolved = new Map<string, LiveMarketQuote>();
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.quote) {
        resolved.set(result.value.slug, result.value.quote);
      }
    }

    const total   = slugs.length;
    const success = resolved.size;
    const failed  = total - success;
    if (failed > 0) {
      log('warn', `Token discovery: ${success}/${total} slugs resolved. ${failed} failed.`);
    } else {
      log('info', `Token discovery: all ${total} slugs resolved.`);
    }

    return resolved;
  }

  invalidate(slug?: string): void {
    if (slug) {
      this.cache.delete(slug);
    } else {
      this.cache.clear();
    }
  }

  cacheSize(): number {
    return this.cache.size;
  }
}
