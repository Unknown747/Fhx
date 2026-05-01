import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

/**
 * MeanReversionStrategy — Single-leg fade when implied probability is stretched.
 *
 * Logic:
 *  - If YES impliedProbability > UPPER_BAND: price is stretched upward → buy NO (cheaper side).
 *  - If NO impliedProbability > UPPER_BAND: price is stretched upward → buy YES (cheaper side).
 *  - Confidence scales with distance from parity (the more stretched, the more confident).
 *
 * This generates single-leg BUY signals targeting the cheaper (underpriced) side.
 * Execution engine handles these as standalone (not paired) orders.
 */
export class MeanReversionStrategy extends Strategy {
  name = 'meanReversion';

  private static readonly UPPER_BAND  = 0.60;   // YES or NO implied prob must exceed this
  private static readonly MIN_EDGE    = 0.01;   // counterparty must be < 0.99
  private static readonly BASE_SIZE   = 20;

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];

    const yesProb = snapshot.yes.impliedProbability;
    const noProb  = snapshot.no.impliedProbability;

    // YES is stretched up → NO is cheap → buy NO
    if (yesProb > MeanReversionStrategy.UPPER_BAND && snapshot.no.bestAsk < (1 - MeanReversionStrategy.MIN_EDGE)) {
      const stretch    = yesProb - MeanReversionStrategy.UPPER_BAND;
      const confidence = Math.min(0.88, 0.60 + stretch * 2.0);
      return [
        {
          strategyName: this.name,
          marketId:     snapshot.marketId,
          tokenId:      snapshot.no.tokenId,
          price:        snapshot.no.bestAsk,
          size:         MeanReversionStrategy.BASE_SIZE,
          side:         'buy',
          confidence:   Number(confidence.toFixed(3)),
          fairValue:    1 - yesProb,
          leg:          'NO',
          rationale:    `Fade stretched YES (${(yesProb * 100).toFixed(1)}% > ${(MeanReversionStrategy.UPPER_BAND * 100).toFixed(1)}%) — buy cheap NO`,
          tags:         ['mean-reversion', 'single-leg', snapshot.asset],
        },
      ];
    }

    // NO is stretched up → YES is cheap → buy YES
    if (noProb > MeanReversionStrategy.UPPER_BAND && snapshot.yes.bestAsk < (1 - MeanReversionStrategy.MIN_EDGE)) {
      const stretch    = noProb - MeanReversionStrategy.UPPER_BAND;
      const confidence = Math.min(0.88, 0.60 + stretch * 2.0);
      return [
        {
          strategyName: this.name,
          marketId:     snapshot.marketId,
          tokenId:      snapshot.yes.tokenId,
          price:        snapshot.yes.bestAsk,
          size:         MeanReversionStrategy.BASE_SIZE,
          side:         'buy',
          confidence:   Number(confidence.toFixed(3)),
          fairValue:    1 - noProb,
          leg:          'YES',
          rationale:    `Fade stretched NO (${(noProb * 100).toFixed(1)}% > ${(MeanReversionStrategy.UPPER_BAND * 100).toFixed(1)}%) — buy cheap YES`,
          tags:         ['mean-reversion', 'single-leg', snapshot.asset],
        },
      ];
    }

    return [];
  }
}
