import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { parse } from 'yaml';

loadEnv({ path: resolve(process.cwd(), '.env'), override: false });

export interface RuntimeSecrets {
  privateKey?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  signatureType: '0' | '1' | '2';
  funder?: string;
  targetPairCost: number;
  orderSize: number;
  dryRun: boolean;
  cooldownSeconds: number;
}

export interface RiskConfig {
  startingCapital: number;
  maxGrossExposure: number;
  maxNetExposure: number;
  maxMarketExposure: number;
  maxOrderNotional: number;
  minOrderNotional: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  maxKellyFraction: number;
  minConfidence: number;
  feeBps: number;
  slippageBps: number;
  circuitBreakerCooldownSeconds: number;
}

export interface MarketConfig {
  asset: string;
  slug: string;
  marketType: string;
  intervalLabel: string;
  prompt: string;
  pairGroup: string;
  referencePrice: number;
  threshold?: number;
  range?: { low?: number; high?: number };
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  noBid: number;
  volumeLabel?: string;
}

export interface RuntimeConfig {
  app: {
    mode: 'paper' | 'live' | 'backtest';
    logLevel: 'info' | 'debug' | 'warn' | 'error';
    loopIntervalMs: number;
  };
  strategy: {
    pairCostCap: number;
    defaultOrderSize: number;
  };
  risk: RiskConfig;
  exchange: {
    host: string;
    gammaHost: string;
    chainId: number;
    pollIntervalMs: number;
    markets: MarketConfig[];
  };
}

let cached: RuntimeConfig | null = null;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadRuntimeSecrets(): RuntimeSecrets {
  return {
    privateKey: process.env.PRIVATE_KEY ?? process.env.POLYMARKET_PRIVATE_KEY,
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    signatureType: (process.env.POLYMARKET_SIGNATURE_TYPE as RuntimeSecrets['signatureType']) ?? '0',
    funder: process.env.POLYMARKET_FUNDER,
    targetPairCost: parseNumber(process.env.TARGET_PAIR_COST, 0.98),
    orderSize: parseNumber(process.env.ORDER_SIZE, 25),
    dryRun: parseBoolean(process.env.DRY_RUN, true),
    cooldownSeconds: parseNumber(process.env.COOLDOWN_SECONDS, 10),
  };
}

function parseRisk(raw: Record<string, unknown>): RiskConfig {
  const n = (key1: string, key2: string, fallback: number) =>
    Number(raw[key1] ?? raw[key2] ?? fallback);
  return {
    startingCapital:               n('starting_capital',            'startingCapital',               25000),
    maxGrossExposure:              n('max_gross_exposure',           'maxGrossExposure',              0.75),
    maxNetExposure:                n('max_net_exposure',             'maxNetExposure',                0.35),
    maxMarketExposure:             n('max_market_exposure',          'maxMarketExposure',             0.15),
    maxOrderNotional:              n('max_order_notional',           'maxOrderNotional',              1500),
    minOrderNotional:              n('min_order_notional',           'minOrderNotional',              25),
    maxDailyLoss:                  n('max_daily_loss',               'maxDailyLoss',                 0.06),
    maxDrawdown:                   n('max_drawdown',                 'maxDrawdown',                  0.10),
    maxKellyFraction:              n('max_kelly_fraction',           'maxKellyFraction',             0.15),
    minConfidence:                 n('min_confidence',               'minConfidence',                0.55),
    feeBps:                        n('fee_bps',                      'feeBps',                       3.5),
    slippageBps:                   n('slippage_bps',                 'slippageBps',                  6.0),
    circuitBreakerCooldownSeconds: n('circuit_breaker_cooldown_s',   'circuitBreakerCooldownSeconds', 300),
  };
}

function parseMarket(m: Record<string, unknown>): MarketConfig {
  const yesAsk = Number(m.yes_ask ?? m.yesAsk ?? 0.5);
  const noAsk  = Number(m.no_ask  ?? m.noAsk  ?? 0.5);
  return {
    asset:         String(m.asset         ?? 'BTC'),
    slug:          String(m.slug          ?? 'unknown'),
    marketType:    String(m.market_type   ?? m.marketType   ?? 'up_down'),
    intervalLabel: String(m.interval_label ?? m.intervalLabel ?? '5 min'),
    prompt:        String(m.prompt        ?? 'Unknown market'),
    pairGroup:     String(m.pair_group    ?? m.pairGroup    ?? m.slug ?? 'unknown'),
    referencePrice:Number(m.reference_price ?? m.referencePrice ?? 0),
    threshold:     m.threshold != null ? Number(m.threshold) : undefined,
    range:         m.range as MarketConfig['range'] | undefined,
    yesTokenId:    String(m.yes_token_id  ?? m.yesTokenId  ?? `${m.slug ?? 'unknown'}-yes`),
    noTokenId:     String(m.no_token_id   ?? m.noTokenId   ?? `${m.slug ?? 'unknown'}-no`),
    yesAsk,
    noAsk,
    yesBid:        Number(m.yes_bid ?? m.yesBid ?? Math.max(0, yesAsk - 0.02)),
    noBid:         Number(m.no_bid  ?? m.noBid  ?? Math.max(0, noAsk  - 0.02)),
    volumeLabel:   m.volume_label != null ? String(m.volume_label ?? m.volumeLabel) : undefined,
  };
}

export function loadConfig(path: string): RuntimeConfig {
  if (cached) return cached;

  const text = readFileSync(resolve(process.cwd(), path), 'utf8');
  const raw = parse(text) as Record<string, unknown>;

  const config: RuntimeConfig = {
    app: { mode: 'paper', logLevel: 'info', loopIntervalMs: 250 },
    strategy: { pairCostCap: 0.98, defaultOrderSize: 25 },
    risk: parseRisk({}),
    exchange: {
      host:           'https://clob.polymarket.com',
      gammaHost:      'https://gamma-api.polymarket.com',
      chainId:        137,
      pollIntervalMs: 500,
      markets:        [],
    },
  };

  if (raw.app && typeof raw.app === 'object') {
    const a = raw.app as Record<string, unknown>;
    config.app.mode           = (a.mode as RuntimeConfig['app']['mode'])           ?? config.app.mode;
    config.app.logLevel       = (a.log_level ?? a.logLevel) as RuntimeConfig['app']['logLevel'] ?? config.app.logLevel;
    config.app.loopIntervalMs = Number(a.loop_interval_ms ?? a.loopIntervalMs)     || config.app.loopIntervalMs;
  }

  if (raw.strategy && typeof raw.strategy === 'object') {
    const s = raw.strategy as Record<string, unknown>;
    config.strategy.pairCostCap      = Number(s.pair_cost_cap      ?? s.pairCostCap)      || config.strategy.pairCostCap;
    config.strategy.defaultOrderSize = Number(s.default_order_size ?? s.defaultOrderSize) || config.strategy.defaultOrderSize;
  }

  if (raw.risk && typeof raw.risk === 'object') {
    config.risk = parseRisk(raw.risk as Record<string, unknown>);
  }

  if (raw.exchange && typeof raw.exchange === 'object') {
    const ex = raw.exchange as Record<string, unknown>;
    config.exchange.host           = String(ex.host         ?? config.exchange.host);
    config.exchange.gammaHost      = String(ex.gamma_host   ?? ex.gammaHost    ?? config.exchange.gammaHost);
    config.exchange.chainId        = Number(ex.chain_id     ?? ex.chainId      ?? config.exchange.chainId);
    config.exchange.pollIntervalMs = Number(ex.poll_interval_ms ?? ex.pollIntervalMs ?? config.exchange.pollIntervalMs);

    if (Array.isArray(ex.markets)) {
      config.exchange.markets = (ex.markets as Record<string, unknown>[]).map(parseMarket);
    }
  }

  cached = config;
  return config;
}

export function resetConfigCache(): void {
  cached = null;
}
