import { createMarketSnapshot, type CryptoAsset, type MarketSnapshot, type MarketType } from './polymarket';

const GAMMA_HOST = process.env.POLYMARKET_GAMMA_HOST ?? 'https://gamma-api.polymarket.com';
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? 'https://clob.polymarket.com';

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  volumeNum?: number;
  volume?: string;
  active?: boolean;
  closed?: boolean;
  endDateIso?: string;
  endDate?: string;
  startDateIso?: string;
  startDate?: string;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  marketType?: string;
  groupItemTitle?: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp?: string;
}

export interface FetchMarketsOptions {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  tagSlug?: string;
  search?: string;
  signal?: AbortSignal;
}

const ASSET_KEYWORDS: Array<{ asset: CryptoAsset; patterns: RegExp[] }> = [
  { asset: 'BTC', patterns: [/\bbitcoin\b/i, /\bbtc\b/i] },
  { asset: 'ETH', patterns: [/\bethereum\b/i, /\beth\b/i] },
  { asset: 'SOL', patterns: [/\bsolana\b/i, /\bsol\b/i] },
  { asset: 'XRP', patterns: [/\bripple\b/i, /\bxrp\b/i] },
  { asset: 'DOGE', patterns: [/\bdogecoin\b/i, /\bdoge\b/i] },
  { asset: 'BNB', patterns: [/\bbnb\b/i, /\bbinance coin\b/i] },
];

function safeJsonParse<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function detectAsset(text: string): CryptoAsset | undefined {
  for (const entry of ASSET_KEYWORDS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.asset;
    }
  }
  return undefined;
}

function detectMarketType(text: string): MarketType {
  const lower = text.toLowerCase();
  if (/(up or down|up\/down|higher or lower)/.test(lower)) return 'up_down';
  if (/(above|below|over|under|reach)/.test(lower)) return 'above_below';
  if (/(hit|touch)/.test(lower)) return 'hit_price';
  if (/(between|range)/.test(lower)) return 'price_range';
  return 'up_down';
}

function detectIntervalLabel(text: string): string {
  const match = text.match(/(\d+\s*(?:second|sec|minute|min|hour|hr|day|week|month|year)s?)/i);
  if (match) return match[1];
  const dateMatch = text.match(/(?:on|by)\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/);
  if (dateMatch) return dateMatch[1];
  return 'open-ended';
}

function formatVolume(volume: number | undefined): string | undefined {
  if (!volume || !Number.isFinite(volume)) return undefined;
  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M Vol.`;
  if (volume >= 1_000) return `$${(volume / 1_000).toFixed(1)}K Vol.`;
  return `$${volume.toFixed(0)} Vol.`;
}

async function jsonFetch<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Polymarket API ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

export async function fetchGammaMarkets(options: FetchMarketsOptions = {}): Promise<GammaMarket[]> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 50));
  if (options.offset != null) params.set('offset', String(options.offset));
  if (options.active != null) params.set('active', String(options.active));
  if (options.closed != null) params.set('closed', String(options.closed));
  if (options.acceptingOrders != null) params.set('accepting_orders', String(options.acceptingOrders));
  if (options.tagSlug) params.set('tag_slug', options.tagSlug);
  return jsonFetch<GammaMarket[]>(`${GAMMA_HOST}/markets?${params.toString()}`, options.signal);
}

export async function fetchOrderBook(tokenId: string, signal?: AbortSignal): Promise<OrderBook> {
  return jsonFetch<OrderBook>(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`, signal);
}

export async function fetchMidpoint(tokenId: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const data = await jsonFetch<{ mid?: string }>(
      `${CLOB_HOST}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
      signal
    );
    const value = Number(data.mid);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function bestLevel(levels: OrderBookLevel[] | undefined, side: 'bid' | 'ask'): number | undefined {
  if (!levels?.length) return undefined;
  const numeric = levels
    .map((level) => Number(level.price))
    .filter((price) => Number.isFinite(price));
  if (!numeric.length) return undefined;
  return side === 'bid' ? Math.max(...numeric) : Math.min(...numeric);
}

export interface LiveMarketQuote {
  market: GammaMarket;
  asset: CryptoAsset;
  marketType: MarketType;
  intervalLabel: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  yesBid?: number;
  noBid?: number;
  volumeLabel?: string;
}

export async function buildLiveQuote(market: GammaMarket, signal?: AbortSignal): Promise<LiveMarketQuote | null> {
  const tokenIds = safeJsonParse<string[]>(market.clobTokenIds);
  const outcomes = safeJsonParse<string[]>(market.outcomes);
  const outcomePrices = safeJsonParse<string[]>(market.outcomePrices);
  if (!tokenIds || tokenIds.length < 2 || !outcomes || outcomes.length < 2) {
    return null;
  }

  const yesIndex = outcomes.findIndex((o) => /yes|up|higher|above|over/i.test(o));
  const noIndex = outcomes.findIndex((o) => /no|down|lower|below|under/i.test(o));
  const yesIdx = yesIndex >= 0 ? yesIndex : 0;
  const noIdx = noIndex >= 0 ? noIndex : 1;

  const yesTokenId = tokenIds[yesIdx];
  const noTokenId = tokenIds[noIdx];

  const fallbackYesAsk = Number(outcomePrices?.[yesIdx]);
  const fallbackNoAsk = Number(outcomePrices?.[noIdx]);

  let yesAsk = Number.isFinite(fallbackYesAsk) ? fallbackYesAsk : 0.5;
  let noAsk = Number.isFinite(fallbackNoAsk) ? fallbackNoAsk : 0.5;
  let yesBid: number | undefined;
  let noBid: number | undefined;

  if (market.enableOrderBook !== false) {
    const [yesBook, noBook] = await Promise.allSettled([
      fetchOrderBook(yesTokenId, signal),
      fetchOrderBook(noTokenId, signal),
    ]);
    if (yesBook.status === 'fulfilled') {
      yesAsk = bestLevel(yesBook.value.asks, 'ask') ?? yesAsk;
      yesBid = bestLevel(yesBook.value.bids, 'bid');
    }
    if (noBook.status === 'fulfilled') {
      noAsk = bestLevel(noBook.value.asks, 'ask') ?? noAsk;
      noBid = bestLevel(noBook.value.bids, 'bid');
    }
  }

  const asset = detectAsset(`${market.question} ${market.slug}`);
  if (!asset) {
    return null;
  }

  return {
    market,
    asset,
    marketType: detectMarketType(market.question ?? ''),
    intervalLabel: detectIntervalLabel(market.question ?? ''),
    yesTokenId,
    noTokenId,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    volumeLabel: formatVolume(market.volumeNum ?? Number(market.volume)),
  };
}

export function liveQuoteToSnapshot(quote: LiveMarketQuote, referencePrice = 0): MarketSnapshot {
  return createMarketSnapshot({
    marketId: quote.market.id,
    slug: quote.market.slug,
    conditionId: quote.market.conditionId ?? `${quote.market.slug}-condition`,
    asset: quote.asset,
    marketType: quote.marketType,
    intervalLabel: quote.intervalLabel,
    prompt: quote.market.question,
    pairGroup: quote.market.slug,
    referencePrice,
    yesTokenId: quote.yesTokenId,
    noTokenId: quote.noTokenId,
    yesAsk: quote.yesAsk,
    noAsk: quote.noAsk,
    yesBid: quote.yesBid,
    noBid: quote.noBid,
    volumeLabel: quote.volumeLabel,
  });
}

export interface FetchLiveSnapshotsOptions extends FetchMarketsOptions {
  assets?: CryptoAsset[];
  maxMarkets?: number;
  concurrency?: number;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchLiveCryptoSnapshots(
  options: FetchLiveSnapshotsOptions = {}
): Promise<MarketSnapshot[]> {
  const markets = await fetchGammaMarkets({
    limit: options.limit ?? 100,
    active: options.active ?? true,
    closed: options.closed ?? false,
    acceptingOrders: options.acceptingOrders ?? true,
    tagSlug: options.tagSlug ?? 'crypto',
    signal: options.signal,
  });

  const filtered = markets
    .filter((market) => market.enableOrderBook !== false)
    .filter((market) => {
      if (!options.assets?.length) return true;
      const asset = detectAsset(`${market.question} ${market.slug}`);
      return asset ? options.assets.includes(asset) : false;
    })
    .slice(0, options.maxMarkets ?? 12);

  const quotes = await mapWithConcurrency(filtered, options.concurrency ?? 4, async (market) => {
    try {
      return await buildLiveQuote(market, options.signal);
    } catch {
      return null;
    }
  });

  return quotes
    .filter((quote): quote is LiveMarketQuote => quote != null)
    .map((quote) => liveQuoteToSnapshot(quote));
}
