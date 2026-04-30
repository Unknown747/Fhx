import { loadConfig, loadRuntimeSecrets } from './config';
import { createMarketSnapshot, type CryptoAsset, type MarketType, type MarketSnapshot } from './connectors/polymarket';
import { ClobOrderClient } from './connectors/clobOrderClient';
import { BacktestEngine } from './backtesting/engine';
import { AutoTradingEngine } from './execution/engine';
import { RiskEngine } from './risk/engine';
import { MarketMakingStrategy } from './strategies/marketMaking';
import { StatisticalArbitrageStrategy } from './strategies/statArb';
import { MomentumStrategy } from './strategies/momentum';
import { MeanReversionStrategy } from './strategies/meanReversion';
import { MetaConfluenceStrategy } from './strategies/metaConfluence';
import {
  log,
  logKeyValue,
  logSection,
  renderExecutionRow,
  renderLaunchBanner,
  renderOpportunityRow,
  renderTableHeader,
} from './utils/logger';

const config  = loadConfig('config/base.yaml');
const secrets = loadRuntimeSecrets();

const strategies = [
  new MarketMakingStrategy(),
  new StatisticalArbitrageStrategy(),
  new MomentumStrategy(),
  new MeanReversionStrategy(),
  new MetaConfluenceStrategy(),
];

const riskEngine = new RiskEngine(config.risk);

function createSnapshotsFromConfig(): MarketSnapshot[] {
  return config.exchange.markets.map((market) =>
    createMarketSnapshot({
      marketId:      market.pairGroup,
      slug:          market.slug,
      conditionId:   `${market.pairGroup}-condition`,
      asset:         market.asset as CryptoAsset,
      marketType:    market.marketType as MarketType,
      intervalLabel: market.intervalLabel,
      prompt:        market.prompt,
      pairGroup:     market.pairGroup,
      referencePrice:market.referencePrice,
      yesTokenId:    market.yesTokenId,
      noTokenId:     market.noTokenId,
      yesAsk:        market.yesAsk,
      noAsk:         market.noAsk,
      yesBid:        market.yesBid,
      noBid:         market.noBid,
      threshold:     market.threshold,
      range:         market.range,
      volumeLabel:   market.volumeLabel,
    })
  );
}

function summarizeWatchlist(snapshots: MarketSnapshot[]): Map<string, number> {
  return snapshots.reduce((acc, snapshot) => {
    acc.set(snapshot.asset, (acc.get(snapshot.asset) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());
}

export function getStrategySignals(snapshot: MarketSnapshot) {
  return strategies.flatMap((strategy) => strategy.generateSignals(snapshot));
}

export default async function run(): Promise<void> {
  const isLive = config.app.mode === 'live' && !secrets.dryRun;

  let clobClient: ClobOrderClient | undefined;

  if (isLive) {
    if (!secrets.privateKey || !secrets.apiKey || !secrets.apiSecret || !secrets.apiPassphrase) {
      log('error', 'Live mode requires PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_API_PASSPHRASE.');
      process.exitCode = 1;
      return;
    }
    clobClient = new ClobOrderClient();
    try {
      await clobClient.init({
        privateKey:    secrets.privateKey,
        apiKey:        secrets.apiKey,
        apiSecret:     secrets.apiSecret,
        apiPassphrase: secrets.apiPassphrase,
        signatureType: secrets.signatureType,
        funder:        secrets.funder,
      });
      log('success', 'CLOB client initialized.', 'Connected to Polymarket mainnet.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'Failed to initialize CLOB client.', msg);
      process.exitCode = 1;
      return;
    }
  }

  const engine = new AutoTradingEngine({
    mode:           config.app.mode,
    dryRun:         secrets.dryRun,
    orderSize:      secrets.orderSize || config.strategy.defaultOrderSize,
    cooldownSeconds:secrets.cooldownSeconds,
    riskEngine,
    clobClient,
  });

  const snapshots = createSnapshotsFromConfig();
  const watchlist = summarizeWatchlist(snapshots);
  const rankedPairs = [...snapshots]
    .filter((s) => s.status === 'live')
    .sort((a, b) => a.combinedAsk - b.combinedAsk);

  const cycleReport = isLive
    ? await engine.runCycleAsync(snapshots, getStrategySignals)
    : engine.runCycle(snapshots, getStrategySignals);

  console.log(renderLaunchBanner(config.app.mode, config.exchange.markets.length, strategies.map((s) => s.name)));

  logSection('🧭 Runtime Snapshot', 'production autotrading profile');
  logKeyValue('Mode',           config.app.mode);
  logKeyValue('Loop Interval',  `${config.app.loopIntervalMs} ms`);
  logKeyValue('Tracked Markets',config.exchange.markets.length);
  logKeyValue('Strategies',     strategies.length);
  logKeyValue('Pair Cost Cap',  config.strategy.pairCostCap.toFixed(2));
  logKeyValue('Order Size',     secrets.orderSize || config.strategy.defaultOrderSize);
  logKeyValue('Cooldown',       `${secrets.cooldownSeconds}s`);

  logSection('🔐 Credentials', '.env loaded — values never logged');
  logKeyValue('PRIVATE_KEY',    secrets.privateKey    ? 'set' : 'MISSING');
  logKeyValue('API Key',        secrets.apiKey        ? 'set' : 'not set');
  logKeyValue('API Secret',     secrets.apiSecret     ? 'set' : 'not set');
  logKeyValue('API Passphrase', secrets.apiPassphrase ? 'set' : 'not set');
  logKeyValue('Signature Type', secrets.signatureType);
  logKeyValue('Funder',         secrets.funder        ? 'set' : 'not set');
  logKeyValue('Dry Run',        secrets.dryRun ? 'true (no real orders)' : 'false (LIVE TRADING)');

  logSection('🪙 Crypto Watchlist', 'binary cards by asset');
  for (const [asset, count] of watchlist.entries()) {
    logKeyValue(asset, count);
  }

  logSection('📡 Opportunity Radar', 'ranked by cheapest paired entry');
  logKeyValue('Eligible Markets', cycleReport.eligibleMarkets);
  logKeyValue('Executed Pairs',   cycleReport.executions.length);
  logKeyValue('Skipped Pairs',    cycleReport.skipped.length);
  console.log(renderTableHeader(['Market', 'Pair', 'Edge', 'Liquidity']));
  rankedPairs.slice(0, 5).forEach((snapshot) => {
    console.log(renderOpportunityRow(snapshot.prompt, snapshot.combinedAsk, Math.max(0, 1 - snapshot.combinedAsk), snapshot.volumeLabel));
  });

  logSection('⚙️ Execution Tape', 'paired order routing results');
  logKeyValue('Scanned',  cycleReport.scannedMarkets);
  logKeyValue('Approved', cycleReport.approvedMarkets);

  if (cycleReport.executions.length > 0) {
    cycleReport.executions.forEach((exec) => {
      const legs = exec.legs
        .map((leg) => `${leg.leg}@${leg.price.toFixed(3)} x${leg.size}${leg.orderId ? ` [${leg.orderId.slice(0, 8)}]` : ''}`)
        .join(` • `);
      console.log(renderExecutionRow(exec.status, exec.marketId, exec.combinedAsk, exec.totalNotional, legs));
      if (exec.error) {
        log('error', `${exec.marketId} execution error.`, exec.error);
      } else {
        log('success', `${exec.strategyName} → ${exec.prompt}.`, `${exec.rationale} • edge=${exec.expectedEdge.toFixed(4)}`);
      }
    });
  } else {
    log('warn', 'No qualifying paired entries this cycle.');
  }

  if (cycleReport.skipped.length > 0) {
    logSection('🧱 Deferred Queue', 'held back by cooldown or risk guards');
    cycleReport.skipped.slice(0, 4).forEach((item) => {
      log('warn', `${item.marketId} deferred.`, item.reason);
    });
  }

  if (config.app.mode === 'backtest') {
    new BacktestEngine(strategies).run(snapshots);
  }

  log('success', 'PolyHFT cycle complete.', `${cycleReport.executions.length} pair(s) processed`);
}

if (require.main === module) {
  run().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'Runtime crashed.', msg);
    process.exitCode = 1;
  });
}
