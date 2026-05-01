import { MarketSnapshot } from '../connectors/polymarket';
import { ClobOrderClient, type ClobCredentials } from '../connectors/clobOrderClient';
import { RiskEngine } from '../risk/engine';
import { TradeSignal } from '../strategies/base';
import { log } from '../utils/logger';

// ─── Data shapes ─────────────────────────────────────────────────────────────

export interface ExecutionLeg {
  leg:      'YES' | 'NO';
  tokenId:  string;
  side:     'buy' | 'sell';
  price:    number;
  size:     number;
  notional: number;
  orderId?: string;
}

export interface PairExecution {
  marketId:      string;
  prompt:        string;
  pairGroup:     string;
  strategyName:  string;
  combinedAsk:   number;
  expectedEdge:  number;
  size:          number;
  totalNotional: number;
  status:        'SIMULATED' | 'ROUTED' | 'FAILED';
  rationale:     string;
  legs:          ExecutionLeg[];
  error?:        string;
}

export interface SingleLegExecution {
  marketId:     string;
  prompt:       string;
  strategyName: string;
  leg:          'YES' | 'NO';
  price:        number;
  size:         number;
  notional:     number;
  status:       'SIMULATED' | 'ROUTED' | 'FAILED';
  rationale:    string;
  orderId?:     string;
  error?:       string;
}

export interface SkippedOpportunity {
  marketId: string;
  prompt:   string;
  reason:   string;
}

export interface CycleReport {
  scannedMarkets:  number;
  eligibleMarkets: number;
  approvedMarkets: number;
  skipped:         SkippedOpportunity[];
  executions:      PairExecution[];
  singleLegs:      SingleLegExecution[];
}

export interface AutoTradingEngineOptions {
  mode:            'paper' | 'live' | 'backtest';
  dryRun:          boolean;
  orderSize:       number;
  cooldownSeconds: number;
  riskEngine:      RiskEngine;
  clobClient?:     ClobOrderClient;
}

// ─── Fill tracker ─────────────────────────────────────────────────────────────

interface PendingFill {
  orderId:     string;
  notional:    number;
  submittedAt: number;
  marketId:    string;
  leg:         'YES' | 'NO';
}

/**
 * FillTracker polls the CLOB for open orders and reconciles fills with the risk engine.
 * In live mode, call `startPolling()` to enable automatic fill detection.
 */
export class FillTracker {
  private readonly pending  = new Map<string, PendingFill>();
  private pollHandle: ReturnType<typeof setInterval> | undefined;

  track(orderId: string, notional: number, marketId: string, leg: 'YES' | 'NO'): void {
    this.pending.set(orderId, { orderId, notional, submittedAt: Date.now(), marketId, leg });
  }

  startPolling(clobClient: ClobOrderClient, riskEngine: RiskEngine, intervalMs = 2_500): void {
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => {
      void this.checkFills(clobClient, riskEngine);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  async checkFills(clobClient: ClobOrderClient, riskEngine: RiskEngine): Promise<void> {
    if (this.pending.size === 0) return;
    try {
      const openOrders = await clobClient.getOpenOrders();
      const openIds    = new Set(
        openOrders
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => String(o['id'] ?? ''))
          .filter(Boolean)
      );

      for (const [id, fill] of this.pending) {
        if (!openIds.has(id)) {
          // Order no longer open → filled or cancelled
          log('success', `Fill detected: ${fill.leg} on ${fill.marketId}`, `orderId=${id.slice(0, 10)} notional=$${fill.notional.toFixed(2)}`);
          riskEngine.recordFill(fill.notional, 0);
          this.pending.delete(id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('warn', 'Fill tracker poll failed.', msg);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

// ─── AutoTradingEngine ───────────────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  return Number(value.toFixed(decimals));
}

export class AutoTradingEngine {
  private readonly lastExecutionByPair = new Map<string, number>();
  private readonly lastSingleLegExec   = new Map<string, number>();
  private readonly isLive:              boolean;
  readonly fillTracker:                 FillTracker;

  constructor(private readonly options: AutoTradingEngineOptions) {
    this.isLive     = options.mode === 'live' && !options.dryRun;
    this.fillTracker = new FillTracker();

    if (this.isLive && options.clobClient) {
      this.fillTracker.startPolling(options.clobClient, options.riskEngine);
    }
  }

  // ── Private: submit one leg to CLOB ─────────────────────────────────────

  private async submitLeg(
    signal: TradeSignal,
    size:   number
  ): Promise<{ orderId?: string; error?: string }> {
    const client = this.options.clobClient;
    if (!client || !client.isReady()) {
      return { error: 'CLOB client not initialized.' };
    }
    try {
      const result = await client.placeOrder({
        tokenId: signal.tokenId,
        side:    signal.side,
        price:   signal.price,
        size,
      });
      return result.success
        ? { orderId: result.orderId }
        : { error: result.errorMsg ?? 'Order rejected by exchange.' };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Public: main async cycle (live + paper) ──────────────────────────────

  async runCycleAsync(
    snapshots:     MarketSnapshot[],
    signalFactory: (snapshot: MarketSnapshot) => TradeSignal[]
  ): Promise<CycleReport> {
    const skipped:   SkippedOpportunity[] = [];
    const executions: PairExecution[]     = [];
    const singleLegs: SingleLegExecution[] = [];
    const now = Date.now();
    let eligibleMarkets = 0;
    let approvedMarkets = 0;

    for (const snapshot of snapshots) {
      if (snapshot.status !== 'live') continue;
      eligibleMarkets += 1;

      const allSignals = signalFactory(snapshot);

      // ── Path A: paired-entry (buy both YES and NO simultaneously) ────────
      const pairedBuys = allSignals.filter(
        (s) => s.side === 'buy' && s.tags.includes('paired-entry')
      );
      const yesSignal = pairedBuys.find((s) => s.leg === 'YES');
      const noSignal  = pairedBuys.find((s) => s.leg === 'NO');

      if (yesSignal && noSignal && snapshot.combinedAsk < 1) {
        const cooldownUntil =
          (this.lastExecutionByPair.get(snapshot.pairGroup) ?? 0) + this.options.cooldownSeconds * 1_000;

        if (cooldownUntil > now) {
          skipped.push({
            marketId: snapshot.marketId,
            prompt:   snapshot.prompt,
            reason:   `pair cooldown ${Math.ceil((cooldownUntil - now) / 1_000)}s`,
          });
        } else {
          const desiredSize  = Math.max(1, this.options.orderSize || yesSignal.size);
          const riskDecision = this.options.riskEngine.evaluate(
            desiredSize,
            snapshot.combinedAsk,
            yesSignal.confidence,
            snapshot.volumeLabel
          );

          if (!riskDecision.approved) {
            skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: riskDecision.reason ?? 'risk rejected pair' });
          } else {
            const approvedSize = riskDecision.approvedSize;
            approvedMarkets   += 1;
            this.lastExecutionByPair.set(snapshot.pairGroup, now);

            const legs: ExecutionLeg[]                    = [];
            let executionStatus: PairExecution['status'] = this.isLive ? 'ROUTED' : 'SIMULATED';
            let executionError: string | undefined;

            for (const signal of [yesSignal, noSignal]) {
              const notional  = round(signal.price * approvedSize, 2);
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
                  log('error', `Order failed: ${signal.leg} on ${snapshot.marketId}.`, error);
                } else if (orderId) {
                  legEntry.orderId = orderId;
                  this.options.riskEngine.recordOpen(notional);
                  this.fillTracker.track(orderId, notional, snapshot.marketId, signal.leg);
                }
              }

              legs.push(legEntry);
            }

            executions.push({
              marketId:      snapshot.marketId,
              prompt:        snapshot.prompt,
              pairGroup:     snapshot.pairGroup,
              strategyName:  yesSignal.strategyName,
              combinedAsk:   snapshot.combinedAsk,
              expectedEdge:  round(1 - snapshot.combinedAsk, 4),
              size:          approvedSize,
              totalNotional: round(snapshot.combinedAsk * approvedSize, 2),
              status:        executionStatus,
              rationale:     yesSignal.rationale,
              legs,
              error:         executionError,
            });
          }
        }
        continue; // snapshot processed via paired path — skip single-leg for same snapshot
      }

      // ── Path B: single-leg BUY signals (momentum, mean reversion, etc.) ─
      const singleBuys = allSignals.filter(
        (s) => s.side === 'buy' && !s.tags.includes('paired-entry')
      );

      for (const signal of singleBuys) {
        const cooldownKey   = `${snapshot.pairGroup}-${signal.strategyName}-${signal.leg}`;
        const cooldownUntil =
          (this.lastSingleLegExec.get(cooldownKey) ?? 0) + this.options.cooldownSeconds * 1_000;

        if (cooldownUntil > now) continue;

        const desiredSize  = Math.max(1, this.options.orderSize || signal.size);
        const riskDecision = this.options.riskEngine.evaluate(
          desiredSize,
          signal.price,
          signal.confidence,
          snapshot.volumeLabel
        );

        if (!riskDecision.approved) {
          skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: `[${signal.strategyName}] ${riskDecision.reason ?? 'risk rejected'}` });
          continue;
        }

        const approvedSize = riskDecision.approvedSize;
        const notional     = round(signal.price * approvedSize, 2);
        approvedMarkets   += 1;
        this.lastSingleLegExec.set(cooldownKey, now);

        let status: SingleLegExecution['status']  = this.isLive ? 'ROUTED' : 'SIMULATED';
        let orderId: string | undefined;
        let error: string | undefined;

        if (this.isLive) {
          const result = await this.submitLeg(signal, approvedSize);
          if (result.error) {
            status = 'FAILED';
            error  = result.error;
            log('error', `Single-leg order failed: ${signal.leg} on ${snapshot.marketId}.`, result.error);
          } else if (result.orderId) {
            orderId = result.orderId;
            this.options.riskEngine.recordOpen(notional);
            this.fillTracker.track(orderId, notional, snapshot.marketId, signal.leg);
          }
        }

        singleLegs.push({
          marketId:     snapshot.marketId,
          prompt:       snapshot.prompt,
          strategyName: signal.strategyName,
          leg:          signal.leg,
          price:        signal.price,
          size:         approvedSize,
          notional,
          status,
          rationale:    signal.rationale,
          orderId,
          error,
        });
      }
    }

    return { scannedMarkets: snapshots.length, eligibleMarkets, approvedMarkets, skipped, executions, singleLegs };
  }

  // ── Public: synchronous cycle (paper / backtest) ─────────────────────────

  runCycle(
    snapshots:     MarketSnapshot[],
    signalFactory: (snapshot: MarketSnapshot) => TradeSignal[]
  ): CycleReport {
    const skipped:    SkippedOpportunity[] = [];
    const executions: PairExecution[]      = [];
    const singleLegs: SingleLegExecution[] = [];
    const now = Date.now();
    let eligibleMarkets = 0;
    let approvedMarkets = 0;

    for (const snapshot of snapshots) {
      if (snapshot.status !== 'live') continue;
      eligibleMarkets += 1;

      const allSignals = signalFactory(snapshot);

      // ── Path A: paired-entry ─────────────────────────────────────────────
      const pairedBuys = allSignals.filter(
        (s) => s.side === 'buy' && s.tags.includes('paired-entry')
      );
      const yesSignal = pairedBuys.find((s) => s.leg === 'YES');
      const noSignal  = pairedBuys.find((s) => s.leg === 'NO');

      if (yesSignal && noSignal && snapshot.combinedAsk < 1) {
        const cooldownUntil =
          (this.lastExecutionByPair.get(snapshot.pairGroup) ?? 0) + this.options.cooldownSeconds * 1_000;

        if (cooldownUntil > now) {
          skipped.push({
            marketId: snapshot.marketId,
            prompt:   snapshot.prompt,
            reason:   `pair cooldown ${Math.ceil((cooldownUntil - now) / 1_000)}s`,
          });
          continue;
        }

        const desiredSize  = Math.max(1, this.options.orderSize || yesSignal.size);
        const riskDecision = this.options.riskEngine.evaluate(
          desiredSize,
          snapshot.combinedAsk,
          yesSignal.confidence,
          snapshot.volumeLabel
        );

        if (!riskDecision.approved) {
          skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: riskDecision.reason ?? 'risk rejected pair' });
          continue;
        }

        const approvedSize = riskDecision.approvedSize;
        approvedMarkets   += 1;
        this.lastExecutionByPair.set(snapshot.pairGroup, now);

        const legs = [yesSignal, noSignal].map((s): ExecutionLeg => ({
          leg:      s.leg,
          tokenId:  s.tokenId,
          side:     s.side,
          price:    s.price,
          size:     approvedSize,
          notional: round(s.price * approvedSize, 2),
        }));

        executions.push({
          marketId:      snapshot.marketId,
          prompt:        snapshot.prompt,
          pairGroup:     snapshot.pairGroup,
          strategyName:  yesSignal.strategyName,
          combinedAsk:   snapshot.combinedAsk,
          expectedEdge:  round(1 - snapshot.combinedAsk, 4),
          size:          approvedSize,
          totalNotional: round(snapshot.combinedAsk * approvedSize, 2),
          status:        this.isLive ? 'ROUTED' : 'SIMULATED',
          rationale:     yesSignal.rationale,
          legs,
        });
        continue;
      }

      // ── Path B: single-leg BUY signals ───────────────────────────────────
      const singleBuys = allSignals.filter(
        (s) => s.side === 'buy' && !s.tags.includes('paired-entry')
      );

      for (const signal of singleBuys) {
        const cooldownKey   = `${snapshot.pairGroup}-${signal.strategyName}-${signal.leg}`;
        const cooldownUntil =
          (this.lastSingleLegExec.get(cooldownKey) ?? 0) + this.options.cooldownSeconds * 1_000;

        if (cooldownUntil > now) continue;

        const desiredSize  = Math.max(1, this.options.orderSize || signal.size);
        const riskDecision = this.options.riskEngine.evaluate(
          desiredSize,
          signal.price,
          signal.confidence,
          snapshot.volumeLabel
        );

        if (!riskDecision.approved) {
          skipped.push({ marketId: snapshot.marketId, prompt: snapshot.prompt, reason: `[${signal.strategyName}] ${riskDecision.reason ?? 'risk rejected'}` });
          continue;
        }

        const approvedSize = riskDecision.approvedSize;
        const notional     = round(signal.price * approvedSize, 2);
        approvedMarkets   += 1;
        this.lastSingleLegExec.set(cooldownKey, now);

        singleLegs.push({
          marketId:     snapshot.marketId,
          prompt:       snapshot.prompt,
          strategyName: signal.strategyName,
          leg:          signal.leg,
          price:        signal.price,
          size:         approvedSize,
          notional,
          status:       this.isLive ? 'ROUTED' : 'SIMULATED',
          rationale:    signal.rationale,
        });
      }
    }

    return { scannedMarkets: snapshots.length, eligibleMarkets, approvedMarkets, skipped, executions, singleLegs };
  }

  destroy(): void {
    this.fillTracker.stopPolling();
  }
}

export { ClobCredentials };
