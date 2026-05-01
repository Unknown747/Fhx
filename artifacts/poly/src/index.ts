import { loadConfig, loadRuntimeSecrets } from './config';
import {
  createMarketSnapshot,
  type CryptoAsset,
  type MarketType,
  type MarketSnapshot,
} from './connectors/polymarket';
import { TokenDiscoveryService } from './connectors/tokenDiscovery';
import { ClobOrderClient } from './connectors/clobOrderClient';
import { BacktestEngine } from './backtesting/engine';
import { AutoTradingEngine } from './execution/engine';
import { RiskEngine } from './risk/engine';
import { MarketMakingStrategy }        from './strategies/marketMaking';
import { VolumeImbalanceStrategy }     from './strategies/volumeImbalance';
import { ResolutionArbStrategy }       from './strategies/resolutionArb';
import { StatisticalArbitrageStrategy } from './strategies/statArb';
import { MomentumStrategy }            from './strategies/momentum';
import { MeanReversionStrategy }       from './strategies/meanReversion';
import { MetaConfluenceStrategy }      from './strategies/metaConfluence';
import {
  log,
  logKeyValue,
  logSection,
  renderExecutionRow,
  renderLaunchBanner,
  renderOpportunityRow,
  renderTableHeader,
} from './utils/logger';
import type { LiveMarketQuote } from './connectors/polymarketApi';

const CONFIG_PATH = 'config/base.yaml';

const config  = loadConfig(CONFIG_PATH);
const secrets = loadRuntimeSecrets();

// Ordered by priority: paired-entry strategies first, single-leg after
const strategies = [
  new MarketMakingStrategy(),        // paired-entry: any edge > 1%
  new VolumeImbalanceStrategy(),     // paired-entry: strong imbalance
  new ResolutionArbStrategy(),       // paired-entry: deep discount > 4.5%
  new StatisticalArbitrageStrategy(), // single-leg: binary identity arb
  new MomentumStrategy(),            // single-leg: directional flow
  new MeanReversionStrategy(),       // single-leg: fade stretched probs
  new MetaConfluenceStrategy(),      // single-leg: multi-indicator blend
];

const riskEngine = new RiskEngine(config.risk);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getStrategySignals(snapshot: MarketSnapshot) {
  return strategies.flatMap((strategy) => strategy.generateSignals(snapshot));
}

function buildSnapshots(liveData: Map<string, LiveMarketQuote>): MarketSnapshot[] {
  return config.exchange.markets.map((market) => {
    const live = liveData.get(market.slug);

    return createMarketSnapshot({
      marketId:      live?.market.id       ?? market.pairGroup,
      slug:          market.slug,
      conditionId:   live?.market.conditionId ?? `${market.pairGroup}-condition`,
      asset:         market.asset         as CryptoAsset,
      marketType:    market.marketType    as MarketType,
      intervalLabel: market.intervalLabel,
      prompt:        live?.market.question ?? market.prompt,
      pairGroup:     market.pairGroup,
      referencePrice:market.referencePrice,
      yesTokenId:    live?.yesTokenId      ?? market.yesTokenId,
      noTokenId:     live?.noTokenId       ?? market.noTokenId,
      yesAsk:        live?.yesAsk          ?? market.yesAsk,
      noAsk:         live?.noAsk           ?? market.noAsk,
      yesBid:        live?.yesBid          ?? market.yesBid,
      noBid:         live?.noBid           ?? market.noBid,
      threshold:     market.threshold,
      range:         market.range,
      volumeLabel:   live?.volumeLabel     ?? market.volumeLabel,
    });
  });
}

function printCycleReport(
  snapshots:    MarketSnapshot[],
  cycleReport:  Awaited<ReturnType<AutoTradingEngine['runCycleAsync']>>,
  cycleNumber:  number,
  elapsed:      number
): void {
  const rankedPairs = [...snapshots]
    .filter((s) => s.status === 'live')
    .sort((a, b) => a.combinedAsk - b.combinedAsk);

  const watchlist = snapshots.reduce((acc, s) => {
    acc.set(s.asset, (acc.get(s.asset) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());

  const totalExecuted = cycleReport.executions.length + cycleReport.singleLegs.length;

  logSection(`⚡ Cycle #${cycleNumber}`, `${elapsed}ms · ${new Date().toISOString()}`);
  logKeyValue('Scanned',    cycleReport.scannedMarkets);
  logKeyValue('Eligible',   cycleReport.eligibleMarkets);
  logKeyValue('Executed',   totalExecuted);
  logKeyValue('Pairs',      cycleReport.executions.length);
  logKeyValue('SingleLegs', cycleReport.singleLegs.length);
  logKeyValue('Skipped',    cycleReport.skipped.length);
  logKeyValue('PendingFills', cycleReport.executions.length > 0 ? '(tracked)' : 0);

  logSection('📡 Opportunity Radar', 'cheapest paired entries');
  console.log(renderTableHeader(['Market', 'Pair', 'Edge', 'Liquidity']));
  rankedPairs.slice(0, 5).forEach((snapshot) => {
    console.log(
      renderOpportunityRow(
        snapshot.prompt,
        snapshot.combinedAsk,
        Math.max(0, 1 - snapshot.combinedAsk),
        snapshot.volumeLabel
      )
    );
  });

  if (cycleReport.executions.length > 0) {
    logSection('⚙️ Paired Executions', 'routed pairs this cycle');
    cycleReport.executions.forEach((exec) => {
      const legs = exec.legs
        .map((leg) =>
          `${leg.leg}@${leg.price.toFixed(3)}×${leg.size}${leg.orderId ? ` [${leg.orderId.slice(0, 8)}]` : ''}`
        )
        .join(' • ');
      console.log(renderExecutionRow(exec.status, exec.marketId, exec.combinedAsk, exec.totalNotional, legs));
      if (exec.error) {
        log('error', `${exec.marketId} execution error.`, exec.error);
      } else {
        log('success', `${exec.strategyName} → ${exec.prompt}`, `edge=${exec.expectedEdge.toFixed(4)} · ${exec.rationale}`);
      }
    });
  }

  if (cycleReport.singleLegs.length > 0) {
    logSection('🎯 Single-Leg Executions', 'directional signals this cycle');
    cycleReport.singleLegs.forEach((exec) => {
      const tag = `${exec.strategyName} → ${exec.leg}@${exec.price.toFixed(3)}×${exec.size}`;
      log(exec.status === 'FAILED' ? 'error' : 'success', tag, exec.rationale);
    });
  }

  if (cycleReport.skipped.length > 0) {
    logSection('🧱 Deferred', 'held by cooldown or risk guards');
    cycleReport.skipped.slice(0, 3).forEach((item) => {
      log('warn', `${item.marketId} deferred.`, item.reason);
    });
  }

  logSection('🪙 Portfolio', 'risk engine state');
  const state = riskEngine.getState();
  logKeyValue('Daily P&L',     `$${state.dailyPnl.toFixed(2)}`);
  logKeyValue('Capital',       `$${state.currentCapital.toFixed(2)}`);
  logKeyValue('Open Notional', `$${state.openNotional.toFixed(2)}`);
  logKeyValue('Peak Capital',  `$${state.peakCapital.toFixed(2)}`);
  logKeyValue('Drawdown',      `${(((state.peakCapital - state.currentCapital) / state.peakCapital) * 100).toFixed(2)}%`);

  for (const [asset, count] of watchlist.entries()) {
    logKeyValue(asset, count);
  }
}

export default async function runLoop(): Promise<void> {
  const isLive = config.app.mode === 'live' && !secrets.dryRun;

  console.log(
    renderLaunchBanner(config.app.mode, config.exchange.markets.length, strategies.map((s) => s.name))
  );

  logSection('🔐 Credentials', '.env loaded — values never logged');
  logKeyValue('PRIVATE_KEY',    secrets.privateKey    ? 'set ✓' : 'MISSING ✗');
  logKeyValue('API Key',        secrets.apiKey        ? 'set ✓' : 'not set');
  logKeyValue('API Secret',     secrets.apiSecret     ? 'set ✓' : 'not set');
  logKeyValue('API Passphrase', secrets.apiPassphrase ? 'set ✓' : 'not set');
  logKeyValue('Signature Type', secrets.signatureType);
  logKeyValue('Funder',         secrets.funder        ? 'set ✓' : 'not set');
  logKeyValue('Dry Run',        secrets.dryRun ? 'true (no real orders)' : 'false (LIVE TRADING)');

  logSection('🧭 Runtime Config', 'loaded from config/base.yaml');
  logKeyValue('Mode',            config.app.mode);
  logKeyValue('Loop Interval',   `${config.app.loopIntervalMs} ms`);
  logKeyValue('Tracked Markets', config.exchange.markets.length);
  logKeyValue('Strategies',      `${strategies.length} (3 paired-entry, 4 single-leg)`);
  logKeyValue('Pair Cost Cap',   config.strategy.pairCostCap.toFixed(2));
  logKeyValue('Order Size',      secrets.orderSize || config.strategy.defaultOrderSize);
  logKeyValue('Cooldown',        `${secrets.cooldownSeconds}s`);
  logKeyValue('Discovery TTL',   '3 min (auto-refresh token IDs)');

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

  // ── Backtest mode ─────────────────────────────────────────────────────────
  if (config.app.mode === 'backtest') {
    const staticSnapshots = buildSnapshots(new Map());
    new BacktestEngine(strategies).run(staticSnapshots);
    return;
  }

  // ── Paper / Live trading loop ─────────────────────────────────────────────
  const engine = new AutoTradingEngine({
    mode:            config.app.mode,
    dryRun:          secrets.dryRun,
    orderSize:       secrets.orderSize || config.strategy.defaultOrderSize,
    cooldownSeconds: secrets.cooldownSeconds,
    riskEngine,
    clobClient,
  });

  const discovery = new TokenDiscoveryService();
  const slugs     = config.exchange.markets.map((m) => m.slug);

  let running     = true;
  let cycleNumber = 0;

  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    log('warn', `${signal} received — shutting down gracefully.`);

    engine.fillTracker.stopPolling();

    if (isLive && clobClient?.isReady()) {
      try {
        await clobClient.cancelAll();
        log('success', 'All open orders cancelled before exit.');
      } catch (err) {
        log('error', 'Could not cancel open orders on shutdown.', err instanceof Error ? err.message : String(err));
      }
    }

    engine.destroy();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  log('info', 'Starting trading loop.', `interval=${config.app.loopIntervalMs}ms · markets=${slugs.length} · strategies=${strategies.length}`);

  while (running) {
    const cycleStart = Date.now();
    cycleNumber     += 1;

    const liveData  = await discovery.resolveAll(slugs);
    const snapshots = buildSnapshots(liveData);

    const cycleReport = isLive
      ? await engine.runCycleAsync(snapshots, getStrategySignals)
      : engine.runCycle(snapshots, getStrategySignals);

    const elapsed = Date.now() - cycleStart;
    printCycleReport(snapshots, cycleReport, cycleNumber, elapsed);

    const waitMs = Math.max(0, config.app.loopIntervalMs - elapsed);
    if (waitMs > 0 && running) {
      await sleep(waitMs);
    }
  }

  log('success', 'PolyHFT shutdown complete.');
}

if (require.main === module) {
  runLoop().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'Runtime crashed.', msg);
    process.exitCode = 1;
  });
}
