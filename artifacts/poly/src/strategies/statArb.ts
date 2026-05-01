import { Strategy, TradeSignal } from './base';
import { MarketSnapshot } from '../connectors/polymarket';

/**
 * StatisticalArbitrageStrategy — Single-leg binary identity curve dislocation.
 *
 * Logic:
 *  - In a binary market: YES + NO = 1.00 at fair value.
 *  - fair_no = 1 - yesImpliedProb
 *  - If NO ask > fair_no + threshold: NO is overpriced → skip (we'd need to sell, requires inventory)
 *  - If NO ask < fair_no - threshold: NO is underpriced → buy NO (positive carry)
 *  - Similarly for YES.
 *
 * Only generates BUY signals (we never assume open inventory for sells).
 */
export class StatisticalArbitrageStrategy extends Strategy {
  name = 'curveArb';

  private static readonly CURVE_THRESHOLD  = 0.03;  // 3% minimum dislocation
  private static readonly BASE_SIZE        = 16;

  generateSignals(snapshot: MarketSnapshot): TradeSignal[] {
    if (snapshot.status !== 'live') return [];

    const yesImplied = snapshot.yes.impliedProbability;
    const noImplied  = snapshot.no.impliedProbability;

    const fairNo  = 1 - yesImplied;
    const fairYes = 1 - noImplied;

    const noMispricing  = fairNo  - snapshot.no.bestAsk;   // positive = NO is cheap
    const yesMispricing = fairYes - snapshot.yes.bestAsk;  // positive = YES is cheap

    const signals: TradeSignal[] = [];

    // NO is underpriced relative to binary identity
    if (noMispricing > StatisticalArbitrageStrategy.CURVE_THRESHOLD && snapshot.no.bestAsk < 0.95) {
      const confidence = Math.min(0.88, 0.58 + noMispricing * 3.0);
      signals.push({
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId:      snapshot.no.tokenId,
        price:        snapshot.no.bestAsk,
        size:         StatisticalArbitrageStrategy.BASE_SIZE,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    fairNo,
        leg:          'NO',
        rationale:    `Curve arb: NO underpriced — ask=${snapshot.no.bestAsk.toFixed(3)}, fair=${fairNo.toFixed(3)}, gap=${noMispricing.toFixed(3)}`,
        tags:         ['curve-arb', 'single-leg', 'binary-identity', snapshot.asset],
      });
    }

    // YES is underpriced relative to binary identity
    if (yesMispricing > StatisticalArbitrageStrategy.CURVE_THRESHOLD && snapshot.yes.bestAsk < 0.95) {
      const confidence = Math.min(0.88, 0.58 + yesMispricing * 3.0);
      signals.push({
        strategyName: this.name,
        marketId:     snapshot.marketId,
        tokenId:      snapshot.yes.tokenId,
        price:        snapshot.yes.bestAsk,
        size:         StatisticalArbitrageStrategy.BASE_SIZE,
        side:         'buy',
        confidence:   Number(confidence.toFixed(3)),
        fairValue:    fairYes,
        leg:          'YES',
        rationale:    `Curve arb: YES underpriced — ask=${snapshot.yes.bestAsk.toFixed(3)}, fair=${fairYes.toFixed(3)}, gap=${yesMispricing.toFixed(3)}`,
        tags:         ['curve-arb', 'single-leg', 'binary-identity', snapshot.asset],
      });
    }

    return signals;
  }
}
