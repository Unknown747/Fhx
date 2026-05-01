import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

/**
 * VolumeImbalanceStrategy — Paired-entry triggered by strong order-book imbalance.
 *
 * Logic:
 *  - High positive imbalance → YES side is getting pushed up → market may be mispriced.
 *  - Buy BOTH sides (paired arb) when imbalance is strong AND combined cost < 1.
 *  - Confidence scales with imbalance magnitude; higher imbalance = clearer signal.
 */
export class VolumeImbalanceStrategy extends Strategy {
  name = 'volumeImbalance';

  private static readonly MIN_IMBALANCE  = 0.12;   // |imbalance| threshold
  private static readonly MIN_EDGE       = 0.015;   // minimum gross edge
  private static readonly BASE_SIZE      = 18;

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];

    const imbalance = Math.abs(snapshot.orderImbalance);
    const edge      = 1 - snapshot.combinedAsk;

    if (imbalance < VolumeImbalanceStrategy.MIN_IMBALANCE) return [];
    if (edge < VolumeImbalanceStrategy.MIN_EDGE)           return [];
    if (snapshot.combinedAsk >= 1)                         return [];

    // Confidence: base from imbalance strength + bonus from edge
    const confidence = Math.min(
      0.92,
      0.55 + imbalance * 1.2 + (edge / 0.10) * 0.15
    );

    const direction = snapshot.orderImbalance > 0 ? 'YES-heavy' : 'NO-heavy';
    const size      = VolumeImbalanceStrategy.BASE_SIZE;

    return [
      {
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId:      snapshot.yes.tokenId,
        price:        snapshot.yes.bestAsk,
        size,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    snapshot.midpoint,
        leg:          'YES',
        rationale:    `Volume imbalance ${direction} imb=${snapshot.orderImbalance.toFixed(3)} edge=${(edge * 100).toFixed(1)}%`,
        tags:         ['paired-entry', 'volume-imbalance', snapshot.asset],
      },
      {
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId:      snapshot.no.tokenId,
        price:        snapshot.no.bestAsk,
        size,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    1 - snapshot.midpoint,
        leg:          'NO',
        rationale:    `Hedge leg for ${snapshot.prompt}`,
        tags:         ['paired-entry', 'volume-imbalance', snapshot.asset],
      },
    ];
  }
}
