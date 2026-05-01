import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

export class MarketMakingStrategy extends Strategy {
  name = 'dualBuyParity';

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];
    if (snapshot.combinedAsk >= 1) return [];

    const edge = 1 - snapshot.combinedAsk;
    if (edge < 0.01) return [];

    // Confidence scales with net edge: 0.01 edge → 0.55, 0.10+ edge → 0.95
    const confidence = Math.min(0.95, 0.55 + (edge / 0.10) * 0.40);
    const fair       = snapshot.fairValue ?? 0.5;
    const size       = 20;

    return [
      {
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId:      snapshot.yes.tokenId,
        price:        snapshot.yes.bestAsk,
        size,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    fair,
        leg:          'YES',
        rationale:    `Parity arb: combinedAsk=${snapshot.combinedAsk.toFixed(3)}, edge=${(edge * 100).toFixed(1)}%`,
        tags:         ['paired-entry', snapshot.marketType, snapshot.asset],
      },
      {
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId:      snapshot.no.tokenId,
        price:        snapshot.no.bestAsk,
        size,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    1 - fair,
        leg:          'NO',
        rationale:    `Hedge leg: ${snapshot.prompt}`,
        tags:         ['paired-entry', snapshot.marketType, snapshot.asset],
      },
    ];
  }
}
