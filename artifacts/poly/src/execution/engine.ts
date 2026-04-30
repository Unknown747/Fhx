import { MarketSnapshot } from '../connectors/polymarket';
import { ClobOrderClient, type ClobCredentials } from '../connectors/clobOrderClient';
import { RiskEngine } from '../risk/engine';
import { TradeSignal } from '../strategies/base';
import { log } from '../utils/logger';

export interface ExecutionLeg {
  leg: 'YES' | 'NO';
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  notional: number;
  orderId?: string;
}

export interface PairExecution {
  marketId: string;
  prompt: string;
  pairGroup: string;
  strategyName: string;
  combinedAsk: number;
  expectedEdge: number;
  size: number;
  totalNotional: number;
  status: 'SIMULATED' | 'ROUTED' | 'FAILED';
  rationale: string;
  legs: ExecutionLeg[];
  error?: string;
}

export interface SkippedOpportunity {
  marketId: string;
  prompt: string;
  reason: string;
}

export interface CycleReport {
  scannedMarkets: number;
  eligibleMarkets: number;
  approvedMarkets: number;
  skipped: SkippedOpportunity[];
  executions: PairExecution[];
}

export interface AutoTradingEngineOptions {
  mode: 'paper' | 'live' | 'backtest';
  dryRun: boolean;
  orderSize: number;
  cooldownSeconds: number;
  riskEngine: RiskEngine;
  clobClient?: ClobOrderClient;
}

function round(value: number, decimals = 2): number {
  return Number(value.toFixed(decimals));
}

export class AutoTradingEngine {
  private readonly lastExecutionByPair = new Map<string, number>();
  private readonly isLive: boolean;

  constructor(private readonly options: AutoTradingEngineOptions) {
    this.isLive = options.mode === 'live' && !options.dryRun;
  }

  private async submitLeg(
    leg: TradeSignal,
    size: number
  ): Promise<{ orderId?: string; error?: string }> {
    const client = this.options.clobClient;
    if (!client || !client.isReady()) {
      return { error: 'CLOB client not initialized.' };
    }
    try {
      const result = await client.placeOrder({
        tokenId: leg.tokenId,
        side:    leg.side,
        price:   leg.price,
        size,
      });
      if (!result.success) {
        return { error: result.errorMsg ?? 'Order rejected by exchange.' };
      }
      return { orderId: result.orderId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async runCycleAsync(
    snapshots: MarketSnapshot[],
    signalFactory: (snapshot: MarketSnapshot) => TradeSignal[]
  ): Promise<CycleReport> {
    const skipped: SkippedOpportunity[] = [];
    const executions: PairExecution[]   = [];
    const now = Date.now();
    let eligibleMarkets = 0;
    let approvedMarkets = 0;

    for (const snapshot of snapshots) {
      if (snapshot.status !== 'live' || snapshot.combinedAsk >= 1) continue;

      eligibleMarkets += 1;

      const signals    = signalFactory(snapshot).filter(
        (s) => s.side === 'buy' && s.tags.includes('paired-entry')
      );
      const yesSignal  = signals.find((s) => s.leg === 'YES');
      const noSignal   = signals.find((s) => s.leg === 'NO');

      if (!yesSignal || !noSignal) {
        skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: 'paired entry incomplete' });
        continue;
      }

      const cooldownUntil =
        (this.lastExecutionByPair.get(snapshot.pairGroup) ?? 0) + this.options.cooldownSeconds * 1000;
      if (cooldownUntil > now) {
        skipped.push({
          marketId: snapshot.marketId,
          prompt:   snapshot.prompt,
          reason:   `cooldown ${Math.ceil((cooldownUntil - now) / 1000)}s remaining`,
        });
        continue;
      }

      const desiredSize   = Math.max(1, this.options.orderSize || yesSignal.size || noSignal.size);
      const riskDecision  = this.options.riskEngine.evaluate(
        desiredSize,
        snapshot.combinedAsk,
        yesSignal.confidence
      );

      if (!riskDecision.approved) {
        skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: riskDecision.reason ?? 'risk rejected pair' });
        continue;
      }

      const approvedSize  = riskDecision.approvedSize;
      approvedMarkets    += 1;
      this.lastExecutionByPair.set(snapshot.pairGroup, now);

      const legs: ExecutionLeg[] = [];
      let executionStatus: PairExecution['status'] = this.isLive ? 'ROUTED' : 'SIMULATED';
      let executionError: string | undefined;

      for (const signal of [yesSignal, noSignal]) {
        const notional = round(signal.price * approvedSize, 2);
        const legEntry: ExecutionLeg = {
          leg:      signal.leg,
          tokenId:  signal.tokenId,
          side:     signal.side,
          price:    signal.price,
          size:     approvedSize,
          notional,
        };

        if (this.isLive) {
          const { orderId, error } = await this.submitLeg(signal, approvedSize);
          if (error) {
            executionStatus = 'FAILED';
            executionError  = error;
            log('error', `Order failed for ${signal.leg} leg on ${snapshot.marketId}.`, error);
          } else {
            legEntry.orderId = orderId;
            this.options.riskEngine.recordOpen(notional);
          }
        }

        legs.push(legEntry);
      }

      const totalNotional = round(snapshot.combinedAsk * approvedSize, 2);
      executions.push({
        marketId:     snapshot.marketId,
        prompt:       snapshot.prompt,
        pairGroup:    snapshot.pairGroup,
        strategyName: yesSignal.strategyName,
        combinedAsk:  snapshot.combinedAsk,
        expectedEdge: round(1 - snapshot.combinedAsk, 4),
        size:         approvedSize,
        totalNotional,
        status:       executionStatus,
        rationale:    yesSignal.rationale,
        legs,
        error:        executionError,
      });
    }

    return { scannedMarkets: snapshots.length, eligibleMarkets, approvedMarkets, skipped, executions };
  }

  runCycle(
    snapshots: MarketSnapshot[],
    signalFactory: (snapshot: MarketSnapshot) => TradeSignal[]
  ): CycleReport {
    const skipped: SkippedOpportunity[] = [];
    const executions: PairExecution[]   = [];
    const now = Date.now();
    let eligibleMarkets = 0;
    let approvedMarkets = 0;

    for (const snapshot of snapshots) {
      if (snapshot.status !== 'live' || snapshot.combinedAsk >= 1) continue;

      eligibleMarkets += 1;

      const signals   = signalFactory(snapshot).filter(
        (s) => s.side === 'buy' && s.tags.includes('paired-entry')
      );
      const yesSignal = signals.find((s) => s.leg === 'YES');
      const noSignal  = signals.find((s) => s.leg === 'NO');

      if (!yesSignal || !noSignal) {
        skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: 'paired entry incomplete' });
        continue;
      }

      const cooldownUntil =
        (this.lastExecutionByPair.get(snapshot.pairGroup) ?? 0) + this.options.cooldownSeconds * 1000;
      if (cooldownUntil > now) {
        skipped.push({
          marketId: snapshot.marketId,
          prompt:   snapshot.prompt,
          reason:   `cooldown ${Math.ceil((cooldownUntil - now) / 1000)}s remaining`,
        });
        continue;
      }

      const desiredSize  = Math.max(1, this.options.orderSize || yesSignal.size || noSignal.size);
      const riskDecision = this.options.riskEngine.evaluate(
        desiredSize,
        snapshot.combinedAsk,
        yesSignal.confidence
      );

      if (!riskDecision.approved) {
        skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: riskDecision.reason ?? 'risk rejected pair' });
        continue;
      }

      const approvedSize = riskDecision.approvedSize;
      approvedMarkets   += 1;
      this.lastExecutionByPair.set(snapshot.pairGroup, now);

      const legs: ExecutionLeg[] = [yesSignal, noSignal].map((signal) => ({
        leg:      signal.leg,
        tokenId:  signal.tokenId,
        side:     signal.side,
        price:    signal.price,
        size:     approvedSize,
        notional: round(signal.price * approvedSize, 2),
      }));

      executions.push({
        marketId:     snapshot.marketId,
        prompt:       snapshot.prompt,
        pairGroup:    snapshot.pairGroup,
        strategyName: yesSignal.strategyName,
        combinedAsk:  snapshot.combinedAsk,
        expectedEdge: round(1 - snapshot.combinedAsk, 4),
        size:         approvedSize,
        totalNotional:round(snapshot.combinedAsk * approvedSize, 2),
        status:       this.isLive ? 'ROUTED' : 'SIMULATED',
        rationale:    yesSignal.rationale,
        legs,
      });
    }

    return { scannedMarkets: snapshots.length, eligibleMarkets, approvedMarkets, skipped, executions };
  }
}

export { ClobCredentials };
