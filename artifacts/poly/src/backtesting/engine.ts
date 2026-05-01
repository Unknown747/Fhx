import { MarketSnapshot } from '../connectors/polymarket';
import { Strategy } from '../strategies/base';
import { log, logKeyValue, logSection } from '../utils/logger';

interface BacktestTrade {
  marketId:    string;
  asset:       string;
  strategyName:string;
  leg:         string;
  price:       number;
  size:        number;
  pnl:         number;   // estimated PnL assuming fair-value resolution
}

interface BacktestSummary {
  totalSignals:  number;
  pairedTrades:  number;
  singleTrades:  number;
  grossEdge:     number;
  estimatedPnl:  number;
  winRate:       number;
  topMarkets:    { marketId: string; pnl: number }[];
  topStrategies: { name: string; count: number }[];
}

export class BacktestEngine {
  constructor(private readonly strategies: Strategy[]) {}

  run(snapshots: MarketSnapshot[]): void {
    logSection('📈 Backtest Engine', 'simulating strategy stack over provided snapshots');
    logKeyValue('Snapshots',  snapshots.length);
    logKeyValue('Strategies', this.strategies.length);

    const trades: BacktestTrade[]  = [];
    const pairGroups = new Set<string>();

    for (const snapshot of snapshots) {
      for (const strategy of this.strategies) {
        const signals = strategy.generateSignals(snapshot);
        if (signals.length === 0) continue;

        const pairedYes = signals.find((s) => s.leg === 'YES' && s.tags.includes('paired-entry'));
        const pairedNo  = signals.find((s) => s.leg === 'NO'  && s.tags.includes('paired-entry'));

        if (pairedYes && pairedNo) {
          const key = `${snapshot.pairGroup}-${strategy.name}`;
          if (pairGroups.has(key)) continue;
          pairGroups.add(key);

          const cost = pairedYes.price + pairedNo.price;
          const edge = 1 - cost;
          const pnl  = edge * pairedYes.size;  // at resolution: YES + NO = 1.00

          trades.push({
            marketId:     snapshot.marketId,
            asset:        snapshot.asset,
            strategyName: strategy.name,
            leg:          'PAIR',
            price:        cost,
            size:         pairedYes.size,
            pnl,
          });

          log('info', `[${strategy.name}] Paired arb on ${snapshot.asset}: cost=${cost.toFixed(3)} edge=${(edge * 100).toFixed(2)}% pnl≈$${pnl.toFixed(2)}`);
          continue;
        }

        for (const signal of signals.filter((s) => !s.tags.includes('paired-entry'))) {
          const resolvedTo = signal.fairValue;
          const pnl        = (resolvedTo - signal.price) * signal.size;

          trades.push({
            marketId:     snapshot.marketId,
            asset:        snapshot.asset,
            strategyName: strategy.name,
            leg:          signal.leg,
            price:        signal.price,
            size:         signal.size,
            pnl,
          });

          log(
            pnl >= 0 ? 'info' : 'warn',
            `[${strategy.name}] ${signal.leg} on ${snapshot.asset}: price=${signal.price.toFixed(3)} fair=${resolvedTo.toFixed(3)} pnl≈$${pnl.toFixed(2)}`
          );
        }
      }
    }

    const summary = this.summarize(trades);
    this.printSummary(summary);
  }

  private summarize(trades: BacktestTrade[]): BacktestSummary {
    const totalSignals   = trades.length;
    const pairedTrades   = trades.filter((t) => t.leg === 'PAIR').length;
    const singleTrades   = totalSignals - pairedTrades;
    const estimatedPnl   = trades.reduce((sum, t) => sum + t.pnl, 0);
    const grossEdge      = trades.reduce((sum, t) => sum + (1 - t.price) * t.size, 0);
    const winners        = trades.filter((t) => t.pnl > 0).length;
    const winRate        = totalSignals > 0 ? winners / totalSignals : 0;

    const byMarket = new Map<string, number>();
    const byStrategy = new Map<string, number>();
    for (const t of trades) {
      byMarket.set(t.marketId, (byMarket.get(t.marketId) ?? 0) + t.pnl);
      byStrategy.set(t.strategyName, (byStrategy.get(t.strategyName) ?? 0) + 1);
    }

    const topMarkets = [...byMarket.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([marketId, pnl]) => ({ marketId, pnl }));

    const topStrategies = [...byStrategy.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    return { totalSignals, pairedTrades, singleTrades, grossEdge, estimatedPnl, winRate, topMarkets, topStrategies };
  }

  private printSummary(s: BacktestSummary): void {
    logSection('📊 Backtest Summary', 'estimated results assuming fair-value resolution');
    logKeyValue('Total Signals',   s.totalSignals);
    logKeyValue('Paired Trades',   s.pairedTrades);
    logKeyValue('Single Trades',   s.singleTrades);
    logKeyValue('Gross Edge ($)',  `$${s.grossEdge.toFixed(2)}`);
    logKeyValue('Estimated P&L',   `$${s.estimatedPnl.toFixed(2)}`);
    logKeyValue('Win Rate',        `${(s.winRate * 100).toFixed(1)}%`);

    if (s.topStrategies.length > 0) {
      logSection('🏆 Signals by Strategy', '');
      for (const { name, count } of s.topStrategies) {
        logKeyValue(name, count);
      }
    }

    if (s.topMarkets.length > 0) {
      logSection('💹 Top Markets by Est. P&L', '');
      for (const { marketId, pnl } of s.topMarkets) {
        logKeyValue(marketId.slice(0, 30), `$${pnl.toFixed(2)}`);
      }
    }
  }
}
