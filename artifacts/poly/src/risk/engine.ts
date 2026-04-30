import type { RiskConfig } from '../config';

export interface RiskDecision {
  approved: boolean;
  approvedSize: number;
  reason?: string;
}

export interface RiskState {
  dailyPnl: number;
  peakCapital: number;
  currentCapital: number;
  openNotional: number;
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

export class RiskEngine {
  private readonly cfg: RiskConfig;
  private state: RiskState;

  constructor(cfg: Partial<RiskConfig> = {}) {
    this.cfg = { ...DEFAULT_RISK, ...cfg };
    this.state = {
      dailyPnl:       0,
      peakCapital:    this.cfg.startingCapital,
      currentCapital: this.cfg.startingCapital,
      openNotional:   0,
    };
  }

  evaluate(size: number, combinedAsk?: number, confidence?: number): RiskDecision {
    const reject = (reason: string): RiskDecision => ({ approved: false, approvedSize: 0, reason });

    if (!Number.isFinite(size) || size <= 0) {
      return reject('Order size must be a positive number.');
    }

    if (combinedAsk !== undefined) {
      if (!Number.isFinite(combinedAsk) || combinedAsk <= 0) {
        return reject('Invalid combinedAsk value.');
      }
      if (combinedAsk >= 1) {
        return reject(`Paired cost ${combinedAsk.toFixed(4)} is not below parity.`);
      }

      const totalCostBps = this.cfg.feeBps + this.cfg.slippageBps;
      const grossEdge    = 1 - combinedAsk;
      const netEdge      = grossEdge - totalCostBps / 10_000;
      if (netEdge <= 0) {
        return reject(
          `Net edge ${(netEdge * 100).toFixed(2)}% negative after fees (${this.cfg.feeBps} bps) + slippage (${this.cfg.slippageBps} bps).`
        );
      }
    }

    if (confidence !== undefined && confidence < this.cfg.minConfidence) {
      return reject(`Confidence ${confidence.toFixed(2)} below minimum ${this.cfg.minConfidence}.`);
    }

    const notional = combinedAsk !== undefined ? combinedAsk * size : size;

    if (notional < this.cfg.minOrderNotional) {
      return reject(
        `Notional $${notional.toFixed(2)} below minimum $${this.cfg.minOrderNotional}.`
      );
    }

    if (notional > this.cfg.maxOrderNotional) {
      const capped = Math.floor(this.cfg.maxOrderNotional / Math.max(combinedAsk ?? 1, 0.001));
      return { approved: true, approvedSize: capped, reason: `Size capped at max notional $${this.cfg.maxOrderNotional}.` };
    }

    const maxMarketNotional = this.state.currentCapital * this.cfg.maxMarketExposure;
    if (notional > maxMarketNotional) {
      const capped = Math.floor(maxMarketNotional / Math.max(combinedAsk ?? 1, 0.001));
      return { approved: true, approvedSize: capped, reason: `Size capped by market exposure limit.` };
    }

    const dailyLossLimit = this.cfg.startingCapital * this.cfg.maxDailyLoss;
    if (this.state.dailyPnl < -dailyLossLimit) {
      return reject(
        `Daily loss limit reached: P&L=${this.state.dailyPnl.toFixed(2)}, limit=${(-dailyLossLimit).toFixed(2)}.`
      );
    }

    const drawdown = (this.state.peakCapital - this.state.currentCapital) / this.state.peakCapital;
    if (drawdown > this.cfg.maxDrawdown) {
      return reject(
        `Max drawdown exceeded: ${(drawdown * 100).toFixed(1)}% > ${(this.cfg.maxDrawdown * 100).toFixed(1)}%.`
      );
    }

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
