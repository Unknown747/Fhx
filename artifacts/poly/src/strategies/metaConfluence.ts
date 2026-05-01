import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

/**
 * MetaConfluenceStrategy — Multi-indicator score blending technical signals.
 *
 * Computes a weighted confluence score from the market's computed IndicatorState.
 * Only fires when confidence >= 0.60 to ensure quality over quantity.
 * Generates a single-leg signal in the direction of the dominant imbalance.
 */
export class MetaConfluenceStrategy extends Strategy {
  name = 'metaConfluence';

  private static readonly MIN_SCORE = 0.60;
  private static readonly BASE_SIZE = 22;

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];

    const ind = snapshot.indicators;
    const ref = Math.max(snapshot.referencePrice, 1);

    const raw =
      ind.supportResistanceFlip * 0.10 +
      ind.bos                   * 0.10 +
      ind.choch                 * 0.08 +
      ind.mss                   * 0.08 +
      ind.wyckoffAccumulation   * 0.08 +
      Math.min(1, ind.rsi / 100)        * 0.12 +
      Math.min(1, ind.stochastic / 100) * 0.08 +
      Math.min(1, Math.abs(ind.liquiditySweep) / 100) * 0.07 +
      Math.min(1, Math.abs(ind.stopHunt) / 100)       * 0.07 +
      Math.min(1, Math.abs(ind.cvd) / 1_000)          * 0.10 +
      Math.min(1, Math.abs(ind.openInterest) / (ref * 1_000_000)) * 0.12;

    const score = Number(Math.min(0.97, Math.max(0.30, raw)).toFixed(3));
    if (score < MetaConfluenceStrategy.MIN_SCORE) return [];

    const isBullish = snapshot.orderImbalance >= 0;
    const leg       = isBullish ? 'YES' : 'NO';
    const tokenId   = isBullish ? snapshot.yes.tokenId  : snapshot.no.tokenId;
    const price     = isBullish ? snapshot.yes.bestAsk   : snapshot.no.bestAsk;

    if (price > 0.90) return [];

    // Build rationale from top contributing indicators
    const contributors: string[] = [];
    if (ind.rsi > 65 || ind.rsi < 35)          contributors.push(`RSI=${ind.rsi.toFixed(0)}`);
    if (ind.bos > 0.5)                          contributors.push('BOS');
    if (ind.choch > 0.4)                        contributors.push('CHoCH');
    if (Math.abs(ind.cvd) > 200)               contributors.push(`CVD=${ind.cvd.toFixed(0)}`);
    if (ind.wyckoffAccumulation > 0.55)        contributors.push('Wyckoff');
    if (Math.abs(ind.liquiditySweep) > 10)     contributors.push('LiqSweep');
    if (contributors.length === 0)              contributors.push('Multi-indicator');

    return [
      {
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId,
        price,
        size:         MetaConfluenceStrategy.BASE_SIZE,
        side:         'buy',
        confidence:   score,
        fairValue:    snapshot.midpoint,
        leg,
        rationale:    `Confluence score=${score} [${contributors.slice(0, 5).join(', ')}] on ${snapshot.asset} ${snapshot.intervalLabel}`,
        tags:         ['meta-confluence', 'single-leg', snapshot.asset, ...contributors.slice(0, 3)],
      },
    ];
  }
}
