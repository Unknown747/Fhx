import type { RiskConfig } from '../config';

export interface RiskDecision {
  approved:     boolean;
  approvedSize: number;
  reason?:      string;
}

export interface RiskState {
  dailyPnl:       number;
  peakCapital:    number;
  currentCapital: number;
  openNotional:   number;
}

const DEFAULT_RISK: RiskConfig = {
  startingCapital:               25_000,
  maxGrossExposure:              0.75,
  maxNetExposure:                0.35,
  maxMarketExposure:             0.15,
  maxOrderNotional:              1_500,
  minOrderNotional:              20,
  maxDailyLoss:                  0.06,
  maxDrawdown:                   0.10,
  maxKellyFraction:              0.15,
  minConfidence:                 0.55,
  feeBps:                        3.5,
  slippageBps:                   6.0,
  circuitBreakerCooldownSeconds: 300,
};

// ─── Volume label → numeric USD ──────────────────────────────────────────────

function parseVolumeLabel(label: string): number {
  const cleaned = label.replace(/[,$\s]/g, '');
  const numPart = parseFloat(cleaned);
  if (!isFinite(numPart)) return 0;
  if (/[Mm]/.test(cleaned)) return numPart * 1_000_000;
  if (/[Kk]/.test(cleaned)) return numPart * 1_000;
  return numPart;
}

// ─── RiskEngine ──────────────────────────────────────────────────────────────

export class RiskEngine {
  private readonly cfg: RiskConfig;
  private state: RiskState;

  constructor(cfg: Partial<RiskConfig> = {}) {
    this.cfg   = { ...DEFAULT_RISK, ...cfg };
    this.state = {
      dailyPnl:       0,
      peakCapital:    this.cfg.startingCapital,
      currentCapital: this.cfg.startingCapital,
      openNotional:   0,
    };
  }

  /**
   * Dynamic slippage: lower-liquidity markets have higher implicit slippage.
   *   < $10K vol  → +40 bps
   *   < $20K vol  → +20 bps
   *   < $50K vol  → +8  bps
   *   unknown vol → +15 bps (conservative)
   *   >= $50K vol → base slippage only
   */
  private effectiveSlippageBps(volumeLabel?: string): number {
    const base = this.cfg.slippageBps;
    if (!volumeLabel) return base + 15;
    const vol = parseVolumeLabel(volumeLabel);
    if (vol === 0)        return base + 15;
    if (vol < 10_000)     return base + 40;
    if (vol < 20_000)     return base + 20;
    if (vol < 50_000)     return base + 8;
    return base;
  }

  /**
   * Evaluate whether a trade passes all risk gates.
   *
   * @param size         Desired order size (shares)
   * @param price        Combined ask (paired entry) or single-leg ask
   * @param confidence   Signal confidence in [0, 1]
   * @param volumeLabel  Optional string like "$142K Vol." for dynamic slippage
   */
  evaluate(
    size:          number,
    price?:        number,
    confidence?:   number,
    volumeLabel?:  string
  ): RiskDecision {
    const reject = (reason: string): RiskDecision => ({ approved: false, approvedSize: 0, reason });

    // Gate 1: size sanity
    if (!Number.isFinite(size) || size <= 0) {
      return reject('Order size must be a positive number.');
    }

    // Gate 2: price / edge checks
    if (price !== undefined) {
      if (!Number.isFinite(price) || price <= 0) {
        return reject('Invalid price value.');
      }
      if (price >= 1) {
        return reject(`Cost ${price.toFixed(4)} is not below $1.00.`);
      }

      const slippageBps  = this.effectiveSlippageBps(volumeLabel);
      const totalCostBps = this.cfg.feeBps + slippageBps;
      const grossEdge    = 1 - price;
      const netEdge      = grossEdge - totalCostBps / 10_000;
      if (netEdge <= 0) {
        return reject(
          `Net edge ${(netEdge * 100).toFixed(2)}% negative after fees(${this.cfg.feeBps}bps) + slippage(${slippageBps.toFixed(1)}bps).`
        );
      }
    }

    // Gate 3: confidence
    if (confidence !== undefined && confidence < this.cfg.minConfidence) {
      return reject(`Confidence ${confidence.toFixed(3)} below minimum ${this.cfg.minConfidence}.`);
    }

    const notional = price !== undefined ? price * size : size;

    // Gate 4: min notional
    if (notional < this.cfg.minOrderNotional) {
      return reject(`Notional $${notional.toFixed(2)} below minimum $${this.cfg.minOrderNotional}.`);
    }

    // Gate 5: max notional (cap, not reject)
    if (notional > this.cfg.maxOrderNotional) {
      const capped = Math.floor(this.cfg.maxOrderNotional / Math.max(price ?? 1, 0.001));
      return { approved: true, approvedSize: capped, reason: `Size capped at max notional $${this.cfg.maxOrderNotional}.` };
    }

    // Gate 6: market exposure cap (cap, not reject)
    const maxMarketNotional = this.state.currentCapital * this.cfg.maxMarketExposure;
    if (notional > maxMarketNotional) {
      const capped = Math.floor(maxMarketNotional / Math.max(price ?? 1, 0.001));
      return { approved: true, approvedSize: capped, reason: 'Size capped by market exposure limit.' };
    }

    // Gate 7: daily loss circuit breaker
    const dailyLossLimit = this.cfg.startingCapital * this.cfg.maxDailyLoss;
    if (this.state.dailyPnl < -dailyLossLimit) {
      return reject(
        `Daily loss limit reached: P&L=${this.state.dailyPnl.toFixed(2)}, limit=${(-dailyLossLimit).toFixed(2)}.`
      );
    }

    // Gate 8: drawdown circuit breaker
    const drawdown = (this.state.peakCapital - this.state.currentCapital) / this.state.peakCapital;
    if (drawdown > this.cfg.maxDrawdown) {
      return reject(
        `Max drawdown ${(drawdown * 100).toFixed(1)}% exceeds limit ${(this.cfg.maxDrawdown * 100).toFixed(1)}%.`
      );
    }

    // Gate 9: gross exposure limit
    const grossExposureAfter = (this.state.openNotional + notional) / this.state.currentCapital;
    if (grossExposureAfter > this.cfg.maxGrossExposure) {
      return reject(
        `Gross exposure ${(grossExposureAfter * 100).toFixed(1)}% would exceed max ${(this.cfg.maxGrossExposure * 100).toFixed(1)}%.`
      );
    }

    return { approved: true, approvedSize: Math.max(1, Math.round(size)) };
  }

  recordFill(notional: number, pnl: number): void {
    this.state.openNotional   = Math.max(0, this.state.openNotional - notional);
    this.state.dailyPnl      += pnl;
    this.state.currentCapital = Math.max(0, this.state.currentCapital + pnl);
    if (this.state.currentCapital > this.state.peakCapital) {
      this.state.peakCapital = this.state.currentCapital;
    }
  }

  recordOpen(notional: number): void {
    this.state.openNotional += notional;
  }

  resetDailyPnl(): void {
    this.state.dailyPnl = 0;
  }

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }
}
