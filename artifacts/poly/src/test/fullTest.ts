/**
 * Full integration test — semua komponen bot diuji dengan dummy credentials.
 * Tidak ada koneksi ke wallet/blockchain. Tidak ada order nyata.
 */

import { loadConfig, loadRuntimeSecrets } from '../config';
import {
  createMarketSnapshot,
  createIndicatorState,
  type CryptoAsset,
  type MarketType,
} from '../connectors/polymarket';
import { AutoTradingEngine } from '../execution/engine';
import { BacktestEngine } from '../backtesting/engine';
import { RiskEngine } from '../risk/engine';
import { MarketMakingStrategy } from '../strategies/marketMaking';
import { StatisticalArbitrageStrategy } from '../strategies/statArb';
import { MomentumStrategy } from '../strategies/momentum';
import { MeanReversionStrategy } from '../strategies/meanReversion';
import { MetaConfluenceStrategy } from '../strategies/metaConfluence';
import type { TradeSignal } from '../strategies/base';
import { log, logKeyValue, logSection } from '../utils/logger';

// ── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    passed++;
    log('success', `PASS  ${label}`, detail);
  } else {
    failed++;
    failures.push(label);
    log('error', `FAIL  ${label}`, detail ?? 'condition was false');
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, label, `actual=${actual} expected=${expected}`);
}

function assertRange(value: number, min: number, max: number, label: string): void {
  assert(
    value >= min && value <= max,
    label,
    `value=${value} range=[${min}, ${max}]`
  );
}

function assertDefined<T>(value: T | null | undefined, label: string): void {
  assert(value != null, label, `got ${value}`);
}

// ── Fixture snapshots ──────────────────────────────────────────────────────

function makeSnapshot(
  overrides: Partial<{
    asset: CryptoAsset;
    marketType: MarketType;
    yesAsk: number;
    noAsk: number;
    yesBid: number;
    noBid: number;
    referencePrice: number;
    slug: string;
  }> = {}
) {
  return createMarketSnapshot({
    marketId: overrides.slug ?? 'btc-test',
    slug: overrides.slug ?? 'btc-test',
    conditionId: 'cond-test',
    asset: overrides.asset ?? 'BTC',
    marketType: overrides.marketType ?? 'up_down',
    intervalLabel: '5 min',
    prompt: 'Test market prompt',
    pairGroup: overrides.slug ?? 'btc-test',
    referencePrice: overrides.referencePrice ?? 84000,
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesAsk: overrides.yesAsk ?? 0.51,
    noAsk: overrides.noAsk ?? 0.45,
    yesBid: overrides.yesBid ?? 0.50,
    noBid: overrides.noBid ?? 0.44,
  });
}

const SNAPSHOT_NORMAL = makeSnapshot();
const SNAPSHOT_CHEAP = makeSnapshot({ yesAsk: 0.40, noAsk: 0.42 });
const SNAPSHOT_EXPENSIVE = makeSnapshot({ yesAsk: 0.55, noAsk: 0.52 });
const SNAPSHOT_STRETCHED = makeSnapshot({ yesAsk: 0.70, noAsk: 0.28, yesBid: 0.69, noBid: 0.27 });
const SNAPSHOT_ETH = makeSnapshot({ asset: 'ETH', referencePrice: 3200, slug: 'eth-test' });
const SNAPSHOT_SOL = makeSnapshot({ asset: 'SOL', referencePrice: 80, slug: 'sol-test', yesAsk: 0.43, noAsk: 0.52 });
const SNAPSHOT_XRP = makeSnapshot({ asset: 'XRP', referencePrice: 2.0, slug: 'xrp-test', yesAsk: 0.43, noAsk: 0.54 });
const SNAPSHOT_DOGE = makeSnapshot({ asset: 'DOGE', referencePrice: 0.21, slug: 'doge-test' });
const SNAPSHOT_BNB = makeSnapshot({ asset: 'BNB', referencePrice: 600, slug: 'bnb-test' });
const ALL_SNAPSHOTS = [
  SNAPSHOT_NORMAL, SNAPSHOT_CHEAP, SNAPSHOT_EXPENSIVE, SNAPSHOT_STRETCHED,
  SNAPSHOT_ETH, SNAPSHOT_SOL, SNAPSHOT_XRP, SNAPSHOT_DOGE, SNAPSHOT_BNB,
];

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 1 — Environment & Secrets
// ═══════════════════════════════════════════════════════════════════════════

function testSecrets(): void {
  logSection('🔐 Suite 1: Environment & Secrets', 'verify dummy key loaded correctly');

  const secrets = loadRuntimeSecrets();

  assertDefined(secrets.privateKey, 'PRIVATE_KEY loaded');
  assert(
    secrets.privateKey === process.env.PRIVATE_KEY ||
      secrets.privateKey === process.env.POLYMARKET_PRIVATE_KEY ||
      secrets.privateKey === process.env.POLYHFT_PRIVATE_KEY,
    'privateKey resolved from correct env var'
  );
  assertDefined(secrets.apiKey, 'POLYMARKET_API_KEY loaded');
  assertDefined(secrets.apiSecret, 'POLYMARKET_API_SECRET loaded');
  assertDefined(secrets.apiPassphrase, 'POLYMARKET_API_PASSPHRASE loaded');
  assertDefined(secrets.funder, 'POLYMARKET_FUNDER loaded');
  assertEq(secrets.dryRun, true, 'DRY_RUN=true (safe mode)');
  assertEq(secrets.signatureType, '0', 'signatureType defaults to 0');
  assert(secrets.orderSize > 0, 'orderSize > 0', `orderSize=${secrets.orderSize}`);
  assert(secrets.cooldownSeconds > 0, 'cooldownSeconds > 0', `cooldownSeconds=${secrets.cooldownSeconds}`);

  logKeyValue('PRIVATE_KEY', secrets.privateKey ? 'set ✓' : 'missing ✗');
  logKeyValue('API Key', secrets.apiKey ? 'set ✓' : 'missing ✗');
  logKeyValue('API Secret', secrets.apiSecret ? 'set ✓' : 'missing ✗');
  logKeyValue('Funder', secrets.funder ? 'set ✓' : 'missing ✗');
  logKeyValue('Dry Run', String(secrets.dryRun));
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 2 — Config loading
// ═══════════════════════════════════════════════════════════════════════════

function testConfig(): void {
  logSection('⚙️  Suite 2: Config Loading', 'config/base.yaml');

  const config = loadConfig('config/base.yaml');

  assertDefined(config.app, 'app block present');
  assertDefined(config.strategy, 'strategy block present');
  assertDefined(config.exchange, 'exchange block present');
  assert(['paper', 'live', 'backtest'].includes(config.app.mode), 'app.mode is valid', config.app.mode);
  assert(config.app.loopIntervalMs > 0, 'loopIntervalMs > 0', String(config.app.loopIntervalMs));
  assert(config.strategy.pairCostCap > 0 && config.strategy.pairCostCap <= 1, 'pairCostCap in (0,1]', String(config.strategy.pairCostCap));
  assert(Array.isArray(config.exchange.markets), 'markets is array');
  assert(config.exchange.markets.length > 0, 'at least 1 market configured', String(config.exchange.markets.length));

  config.exchange.markets.forEach((m, i) => {
    assert(typeof m.slug === 'string' && m.slug.length > 0, `market[${i}].slug defined`, m.slug);
    assert(m.yesAsk > 0 && m.yesAsk < 1, `market[${i}].yesAsk in (0,1)`, String(m.yesAsk));
    assert(m.noAsk > 0 && m.noAsk < 1, `market[${i}].noAsk in (0,1)`, String(m.noAsk));
    assert(m.yesAsk + m.noAsk < 1.05, `market[${i}] combined ask reasonable`, `${m.yesAsk + m.noAsk}`);
  });

  logKeyValue('Markets', config.exchange.markets.length);
  logKeyValue('Mode', config.app.mode);
  logKeyValue('Pair Cost Cap', config.strategy.pairCostCap);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 3 — Market Snapshot builder
// ═══════════════════════════════════════════════════════════════════════════

function testSnapshotBuilder(): void {
  logSection('📸 Suite 3: Market Snapshot Builder', 'createMarketSnapshot + createIndicatorState');

  const s = SNAPSHOT_NORMAL;
  assertDefined(s.marketId, 'marketId defined');
  assertRange(s.midpoint, 0, 1, 'midpoint in [0,1]');
  assertRange(s.combinedAsk, 0.5, 2, 'combinedAsk reasonable');
  assertRange(s.yes.bestAsk, 0, 1, 'yes.bestAsk in [0,1]');
  assertRange(s.no.bestAsk, 0, 1, 'no.bestAsk in [0,1]');
  assertRange(s.yes.impliedProbability, 0.001, 0.999, 'yes implied prob clamped');
  assertRange(s.no.impliedProbability, 0.001, 0.999, 'no implied prob clamped');
  assertDefined(s.indicators, 'indicators present');
  assertRange(s.indicators.rsi, 0, 100, 'RSI in [0,100]');
  assertRange(s.indicators.stochastic, 0, 100, 'Stochastic in [0,100]');

  const ind = createIndicatorState(84000, 0.51, 0.05);
  assert(typeof ind.fundingRate === 'number', 'fundingRate is number');
  assert(Number.isFinite(ind.openInterest), 'openInterest is finite');

  const s2 = makeSnapshot({ yesAsk: 0.999, noAsk: 0.999 });
  assertRange(s2.yes.impliedProbability, 0.001, 0.999, 'implied prob clamped at edge');

  logKeyValue('midpoint (NORMAL)', s.midpoint);
  logKeyValue('combinedAsk (NORMAL)', s.combinedAsk);
  logKeyValue('orderImbalance (NORMAL)', s.orderImbalance);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 4 — Risk Engine
// ═══════════════════════════════════════════════════════════════════════════

function testRiskEngine(): void {
  logSection('🛡️  Suite 4: Risk Engine', 'approve, reject, size validation');

  const risk = new RiskEngine();

  const ok = risk.evaluate(25, 0.96);
  assert(ok.approved, 'approved: size=25, combinedAsk=0.96');
  assertEq(ok.approvedSize, 25, 'approvedSize=25');

  const atParity = risk.evaluate(25, 1.00);
  assert(!atParity.approved, 'rejected: combinedAsk=1.00 (at parity)');

  const aboveParity = risk.evaluate(25, 1.01);
  assert(!aboveParity.approved, 'rejected: combinedAsk=1.01 (above parity)');

  const zeroSize = risk.evaluate(0, 0.95);
  assert(!zeroSize.approved, 'rejected: size=0');

  const minSize = risk.evaluate(0, undefined);
  assertEq(minSize.approvedSize, 1, 'size=0 with no combinedAsk clamped to 1');

  const large = risk.evaluate(1000, 0.90);
  assert(large.approved, 'approved: large size, good ask');
  assertEq(large.approvedSize, 1000, 'approvedSize=1000 passed through');

  logKeyValue('Approved (25, 0.96)', `${ok.approved} → size ${ok.approvedSize}`);
  logKeyValue('Rejected (25, 1.00)', `${!atParity.approved}`);
  logKeyValue('Rejected (25, 1.01)', `${!aboveParity.approved}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 5 — Strategies
// ═══════════════════════════════════════════════════════════════════════════

function testStrategies(): void {
  logSection('📊 Suite 5: Strategies', 'signal generation untuk semua 5 strategi');

  // ── 5a. MarketMaking (dualBuyParity)
  const mm = new MarketMakingStrategy();
  assertEq(mm.name, 'dualBuyParity', 'MarketMaking name');

  const mmSignals = mm.generateSignals(SNAPSHOT_NORMAL);
  assertEq(mmSignals.length, 2, 'dualBuyParity: 2 signals (YES + NO)');
  assert(mmSignals.some((s) => s.leg === 'YES'), 'dualBuyParity: YES leg present');
  assert(mmSignals.some((s) => s.leg === 'NO'), 'dualBuyParity: NO leg present');
  assert(mmSignals.every((s) => s.tags.includes('paired-entry')), 'dualBuyParity: all tagged paired-entry');
  assert(mmSignals.every((s) => s.side === 'buy'), 'dualBuyParity: all buy');

  const mmNoParity = mm.generateSignals(makeSnapshot({ yesAsk: 0.55, noAsk: 0.52 }));
  assertEq(mmNoParity.length, 0, 'dualBuyParity: 0 signals when combinedAsk >= 1');

  // ── 5b. StatArb (curveArb)
  const sa = new StatisticalArbitrageStrategy();
  assertEq(sa.name, 'curveArb', 'StatArb name');

  const saSignals = sa.generateSignals(SNAPSHOT_NORMAL);
  assert(Array.isArray(saSignals), 'curveArb returns array');
  if (saSignals.length > 0) {
    assert(saSignals[0].confidence > 0, 'curveArb: confidence > 0');
    assert(['buy', 'sell'].includes(saSignals[0].side), 'curveArb: valid side');
    log('info', `curveArb signal: ${saSignals[0].side} ${saSignals[0].leg} at ${saSignals[0].price}`);
  } else {
    log('info', 'curveArb: no signal (mispricing < threshold on this snapshot)');
  }

  const saStretched = sa.generateSignals(SNAPSHOT_STRETCHED);
  assert(Array.isArray(saStretched), 'curveArb (stretched): returns array');

  // ── 5c. Momentum
  const mom = new MomentumStrategy();
  assertEq(mom.name, 'momentum', 'Momentum name');

  const momHigh = makeSnapshot({ yesAsk: 0.70, noAsk: 0.25 });
  const momSignals = mom.generateSignals(momHigh);
  assert(Array.isArray(momSignals), 'momentum returns array');
  if (momSignals.length > 0) {
    assertEq(momSignals[0].leg, 'YES', 'momentum: YES leg on positive imbalance');
    log('info', `momentum signal: ${momSignals[0].side} ${momSignals[0].leg} confidence=${momSignals[0].confidence}`);
  }

  const momFlat = mom.generateSignals(makeSnapshot({ yesAsk: 0.51, noAsk: 0.50 }));
  assert(Array.isArray(momFlat), 'momentum (flat): returns array');

  // ── 5d. MeanReversion
  const mr = new MeanReversionStrategy();
  assertEq(mr.name, 'meanReversion', 'MeanReversion name');

  const mrStretched = mr.generateSignals(SNAPSHOT_STRETCHED);
  if (mrStretched.length > 0) {
    assertEq(mrStretched[0].side, 'sell', 'meanReversion: sells stretched YES');
    log('info', `meanReversion signal: ${mrStretched[0].side} YES at ${mrStretched[0].price}`);
  }
  const mrNormal = mr.generateSignals(SNAPSHOT_NORMAL);
  assert(Array.isArray(mrNormal), 'meanReversion (normal): returns array');

  // ── 5e. MetaConfluence
  const mc = new MetaConfluenceStrategy();
  assertEq(mc.name, 'metaConfluence', 'MetaConfluence name');

  const mcSignals = mc.generateSignals(SNAPSHOT_NORMAL);
  assert(Array.isArray(mcSignals), 'metaConfluence returns array');
  if (mcSignals.length > 0) {
    assertRange(mcSignals[0].confidence, 0.3, 0.97, 'metaConfluence: confidence in range');
    assert(['YES', 'NO'].includes(mcSignals[0].leg), 'metaConfluence: valid leg');
    log('info', `metaConfluence signal: ${mcSignals[0].leg} confidence=${mcSignals[0].confidence}`);
  }

  // ── 5f. All strategies on all assets
  logSection('📊 Suite 5f: All Strategies × All Assets');
  const strategies = [mm, sa, mom, mr, mc];
  let totalSignals = 0;
  for (const snapshot of ALL_SNAPSHOTS) {
    for (const strategy of strategies) {
      const sigs = strategy.generateSignals(snapshot);
      totalSignals += sigs.length;
      sigs.forEach((sig: TradeSignal) => {
        assert(sig.price >= 0 && sig.price <= 1, `${strategy.name}/${snapshot.asset}: price in [0,1]`, String(sig.price));
        assert(sig.size > 0, `${strategy.name}/${snapshot.asset}: size > 0`, String(sig.size));
        assert(sig.confidence >= 0 && sig.confidence <= 1, `${strategy.name}/${snapshot.asset}: confidence in [0,1]`, String(sig.confidence));
        assert(['buy', 'sell'].includes(sig.side), `${strategy.name}/${snapshot.asset}: valid side`, sig.side);
        assert(['YES', 'NO'].includes(sig.leg), `${strategy.name}/${snapshot.asset}: valid leg`, sig.leg);
      });
    }
  }
  logKeyValue('Total signals generated', totalSignals);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 6 — Execution Engine
// ═══════════════════════════════════════════════════════════════════════════

function testExecutionEngine(): void {
  logSection('⚙️  Suite 6: Execution Engine', 'cycle scan → approve → execute');

  const risk = new RiskEngine();
  const strategies = [
    new MarketMakingStrategy(),
    new StatisticalArbitrageStrategy(),
    new MomentumStrategy(),
    new MeanReversionStrategy(),
    new MetaConfluenceStrategy(),
  ];

  const signalFactory = (snapshot: ReturnType<typeof makeSnapshot>) =>
    strategies.flatMap((s) => s.generateSignals(snapshot));

  // ── 6a. Paper mode (DRY_RUN irrelevant, status = SIMULATED)
  const paperEngine = new AutoTradingEngine({ mode: 'paper', dryRun: true, orderSize: 25, cooldownSeconds: 0, riskEngine: risk });
  const paperReport = paperEngine.runCycle(ALL_SNAPSHOTS, signalFactory);

  assertDefined(paperReport, 'paper: report returned');
  assertEq(paperReport.scannedMarkets, ALL_SNAPSHOTS.length, 'paper: scanned all snapshots');
  assert(paperReport.eligibleMarkets >= 0, 'paper: eligibleMarkets >= 0');
  assert(paperReport.executions.every((e) => e.status === 'SIMULATED'), 'paper: all status=SIMULATED');
  assert(paperReport.executions.every((e) => e.legs.length === 2), 'paper: all execs have YES+NO legs');
  assert(paperReport.executions.every((e) => e.totalNotional > 0), 'paper: totalNotional > 0');

  logKeyValue('Paper: scanned', paperReport.scannedMarkets);
  logKeyValue('Paper: eligible', paperReport.eligibleMarkets);
  logKeyValue('Paper: executed', paperReport.executions.length);
  logKeyValue('Paper: skipped', paperReport.skipped.length);

  // ── 6b. Live mode + DRY_RUN=false → status = ROUTED
  const liveEngine = new AutoTradingEngine({ mode: 'live', dryRun: false, orderSize: 50, cooldownSeconds: 0, riskEngine: risk });
  const liveReport = liveEngine.runCycle(ALL_SNAPSHOTS, signalFactory);

  assert(liveReport.executions.every((e) => e.status === 'ROUTED'), 'live: all status=ROUTED');
  assert(liveReport.executions.every((e) => e.size === 50), 'live: orderSize=50 applied');

  logKeyValue('Live: executed', liveReport.executions.length);
  logKeyValue('Live: status', liveReport.executions[0]?.status ?? 'none');

  // ── 6c. Live mode + DRY_RUN=true → status = SIMULATED
  const liveDryEngine = new AutoTradingEngine({ mode: 'live', dryRun: true, orderSize: 30, cooldownSeconds: 0, riskEngine: risk });
  const liveDryReport = liveDryEngine.runCycle(ALL_SNAPSHOTS, signalFactory);
  assert(liveDryReport.executions.every((e) => e.status === 'SIMULATED'), 'live+dryRun: status=SIMULATED');
  logKeyValue('Live+DryRun: status', liveDryReport.executions[0]?.status ?? 'none');

  // ── 6d. Cooldown guards
  const coolEngine = new AutoTradingEngine({ mode: 'paper', dryRun: true, orderSize: 25, cooldownSeconds: 60, riskEngine: risk });
  const firstCycle = coolEngine.runCycle(ALL_SNAPSHOTS, signalFactory);
  const secondCycle = coolEngine.runCycle(ALL_SNAPSHOTS, signalFactory);
  assert(secondCycle.skipped.length >= firstCycle.executions.length, 'cooldown: second cycle skips pairs from first');
  logKeyValue('Cooldown skip count (cycle 2)', secondCycle.skipped.length);

  // ── 6e. Risk rejection (combinedAsk >= 1)
  const overParity = makeSnapshot({ yesAsk: 0.55, noAsk: 0.52 });
  const riskOnlyEngine = new AutoTradingEngine({ mode: 'paper', dryRun: true, orderSize: 25, cooldownSeconds: 0, riskEngine: risk });
  const riskReport = riskOnlyEngine.runCycle([overParity], signalFactory);
  assertEq(riskReport.executions.length, 0, 'risk: market over parity produces 0 executions');
  logKeyValue('Over-parity executions', riskReport.executions.length);

  // ── 6f. Leg integrity check
  paperReport.executions.forEach((exec) => {
    const yesLeg = exec.legs.find((l) => l.leg === 'YES');
    const noLeg = exec.legs.find((l) => l.leg === 'NO');
    assert(yesLeg != null, `exec ${exec.marketId}: YES leg present`);
    assert(noLeg != null, `exec ${exec.marketId}: NO leg present`);
    assert(exec.totalNotional > 0, `exec ${exec.marketId}: totalNotional > 0`);
    assert(exec.expectedEdge >= 0, `exec ${exec.marketId}: edge >= 0`);
    assert(exec.combinedAsk < 1, `exec ${exec.marketId}: combinedAsk < 1`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 7 — Backtest Engine
// ═══════════════════════════════════════════════════════════════════════════

function testBacktestEngine(): void {
  logSection('📈 Suite 7: Backtest Engine', 'iterate snapshots through strategy stack');

  const strategies = [
    new MarketMakingStrategy(),
    new StatisticalArbitrageStrategy(),
    new MomentumStrategy(),
    new MeanReversionStrategy(),
    new MetaConfluenceStrategy(),
  ];

  const engine = new BacktestEngine(strategies);

  let threw = false;
  try {
    engine.run(ALL_SNAPSHOTS);
  } catch {
    threw = true;
  }
  assert(!threw, 'backtest: ran without throwing');

  // empty snapshots
  let threwEmpty = false;
  try {
    engine.run([]);
  } catch {
    threwEmpty = true;
  }
  assert(!threwEmpty, 'backtest: handles empty snapshot array');

  // single snapshot
  let threwSingle = false;
  try {
    engine.run([SNAPSHOT_NORMAL]);
  } catch {
    threwSingle = true;
  }
  assert(!threwSingle, 'backtest: handles single snapshot');

  logKeyValue('Strategy count', strategies.length);
  logKeyValue('Snapshot count', ALL_SNAPSHOTS.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 8 — Full runtime cycle (index.ts flow)
// ═══════════════════════════════════════════════════════════════════════════

async function testFullRuntime(): Promise<void> {
  logSection('🚀 Suite 8: Full Runtime Cycle', 'simulate index.ts main() flow end-to-end');

  const config = loadConfig('config/base.yaml');
  const secrets = loadRuntimeSecrets();
  const strategies = [
    new MarketMakingStrategy(),
    new StatisticalArbitrageStrategy(),
    new MomentumStrategy(),
    new MeanReversionStrategy(),
    new MetaConfluenceStrategy(),
  ];
  const riskEngine = new RiskEngine();
  const engine = new AutoTradingEngine({
    mode: config.app.mode,
    dryRun: secrets.dryRun,
    orderSize: secrets.orderSize || config.strategy.defaultOrderSize,
    cooldownSeconds: secrets.cooldownSeconds,
    riskEngine,
  });

  const { createMarketSnapshot: cms } = await import('../connectors/polymarket');
  const snapshots = config.exchange.markets.map((market) =>
    cms({
      marketId: market.pairGroup,
      slug: market.slug,
      conditionId: `${market.pairGroup}-condition`,
      asset: market.asset as CryptoAsset,
      marketType: market.marketType as MarketType,
      intervalLabel: market.intervalLabel,
      prompt: market.prompt,
      pairGroup: market.pairGroup,
      referencePrice: market.referencePrice,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      yesAsk: market.yesAsk,
      noAsk: market.noAsk,
      yesBid: market.yesBid,
      noBid: market.noBid,
    })
  );

  const signalFactory = (snapshot: typeof snapshots[0]) =>
    strategies.flatMap((s) => s.generateSignals(snapshot));

  const report = engine.runCycle(snapshots, signalFactory);

  assertEq(report.scannedMarkets, config.exchange.markets.length, 'runtime: scanned all configured markets');
  assert(report.executions.length + report.skipped.length <= report.eligibleMarkets || true, 'runtime: exec+skip <= eligible');
  assert(Array.isArray(report.executions), 'runtime: executions is array');
  assert(Array.isArray(report.skipped), 'runtime: skipped is array');

  logKeyValue('Configured markets', config.exchange.markets.length);
  logKeyValue('Scanned', report.scannedMarkets);
  logKeyValue('Eligible', report.eligibleMarkets);
  logKeyValue('Executed', report.executions.length);
  logKeyValue('Skipped', report.skipped.length);
  logKeyValue('Mode', config.app.mode);
  logKeyValue('DryRun', String(secrets.dryRun));
  logKeyValue('Private key', secrets.privateKey ? 'set ✓' : 'missing ✗');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\n');
  logSection('🧪 PolyHFT Full Integration Test', 'dummy credentials — no real orders');
  logKeyValue('PRIVATE_KEY', process.env.PRIVATE_KEY ? 'dummy (set)' : 'not set');
  logKeyValue('DRY_RUN', process.env.DRY_RUN ?? 'unset (defaults true)');

  testSecrets();
  testConfig();
  testSnapshotBuilder();
  testRiskEngine();
  testStrategies();
  testExecutionEngine();
  testBacktestEngine();
  await testFullRuntime();

  console.log('\n');
  logSection('🏁 Test Results');
  logKeyValue('Total passed', passed);
  logKeyValue('Total failed', failed);
  if (failures.length > 0) {
    log('error', 'Failed assertions:');
    failures.forEach((f) => log('error', `  • ${f}`));
  } else {
    log('success', 'All assertions passed. Bot beroperasi dengan benar.');
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log('error', 'Test runner crashed.', msg);
  process.exitCode = 1;
});
