import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

/**
 * ResolutionArbStrategy — Deep-discount paired entry for markets with wide edge.
 *
 * Logic:
 *  - A 5-min market resolves to 1.0 within minutes of cut-off.
 *  - If combinedAsk is deeply below parity (> DEEP_EDGE threshold), the market
 *    is structurally mispriced and the pair will pay out $1.00 at resolution.
 *  - This strategy fires at higher confidence than marketMaking because the edge
 *    is large enough to clearly cover fees + slippage.
 *
 * Note: Size is intentionally larger to capture the full arbitrage before prices correct.
 */
export class ResolutionArbStrategy extends Strategy {
  name = 'resolutionArb';

  private static readonly DEEP_EDGE  = 0.045;   // at least 4.5% edge required
  private static readonly BASE_SIZE  = 28;

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];

    const edge = 1 - snapshot.combinedAsk;
    if (edge < ResolutionArbStrategy.DEEP_EDGE) return [];

    // Confidence: strong baseline + scale with edge depth
    const confidence = Math.min(0.97, 0.72 + (edge - ResolutionArbStrategy.DEEP_EDGE) / 0.05 * 0.20);
    const size       = ResolutionArbStrategy.BASE_SIZE;

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
        rationale:    `Deep-discount arb: combinedAsk=${snapshot.combinedAsk.toFixed(3)}, edge=${(edge * 100).toFixed(1)}% > ${(ResolutionArbStrategy.DEEP_EDGE * 100).toFixed(1)}% threshold`,
        tags:         ['paired-entry', 'resolution-arb', snapshot.asset, snapshot.intervalLabel],
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
        tags:         ['paired-entry', 'resolution-arb', snapshot.asset, snapshot.intervalLabel],
      },
    ];
  }
}
