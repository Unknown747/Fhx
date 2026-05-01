import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

/**
 * MomentumStrategy — Single-leg directional follow when order-book imbalance is strong.
 *
 * Logic:
 *  - Strong positive imbalance (YES pressure) → buy YES (ride the flow).
 *  - Strong negative imbalance (NO pressure)  → buy NO  (ride the flow).
 *  - Confidence scales with imbalance magnitude.
 *
 * Uses 'single-leg' tag — execution engine routes this independently (not as a pair).
 */
export class MomentumStrategy extends Strategy {
  name = 'momentum';

  private static readonly MIN_IMBALANCE = 0.18;  // strong enough to trade
  private static readonly BASE_SIZE     = 15;

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];

    const imbalance = snapshot.orderImbalance;

    if (Math.abs(imbalance) < MomentumStrategy.MIN_IMBALANCE) return [];

    const isBullish  = imbalance > 0;
    const tokenId    = isBullish ? snapshot.yes.tokenId : snapshot.no.tokenId;
    const price      = isBullish ? snapshot.yes.bestAsk  : snapshot.no.bestAsk;
    const leg        = isBullish ? 'YES' : 'NO';
    const confidence = Math.min(0.87, 0.58 + Math.abs(imbalance) * 1.5);

    // Must be below 0.90 — too expensive = risk of mean reversion
    if (price > 0.90) return [];

    return [
      {
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId,
        price,
        size:         MomentumStrategy.BASE_SIZE,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    snapshot.midpoint,
        leg,
        rationale:    `Momentum ${isBullish ? 'bullish' : 'bearish'} on ${snapshot.asset} ${snapshot.intervalLabel}: imbalance=${imbalance.toFixed(3)}`,
        tags:         ['momentum', 'single-leg', snapshot.intervalLabel, snapshot.asset],
      },
    ];
  }
}
