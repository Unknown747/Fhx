import { fetchLiveCryptoSnapshots } from '../connectors/polymarketApi';
import type { CryptoAsset, MarketSnapshot } from '../connectors/polymarket';
import {
  log,
  logKeyValue,
  logSection,
  renderOpportunityRow,
  renderTableHeader,
} from '../utils/logger';

const ASSETS: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'];

function summarizeByAsset(snapshots: MarketSnapshot[]): Map<CryptoAsset, number> {
  return snapshots.reduce((acc, snapshot) => {
    const key = snapshot.asset as CryptoAsset;
    acc.set(key, (acc.get(key) ?? 0) + 1);
    return acc;
  }, new Map<CryptoAsset, number>());
}

async function main(): Promise<void> {
  logSection('🌐 Polymarket Live Feed', 'read-only Gamma + CLOB fetch');
  log('info', 'Fetching active crypto markets from Polymarket...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let snapshots: MarketSnapshot[] = [];
  try {
    snapshots = await fetchLiveCryptoSnapshots({
      assets: ASSETS,
      limit: 200,
      maxMarkets: 20,
      concurrency: 4,
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to fetch live markets.', message);
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!snapshots.length) {
    log('warn', 'No live crypto markets returned by Polymarket.');
    return;
  }

  logKeyValue('Markets Returned', snapshots.length);
  logSection('🪙 Crypto Distribution', 'live markets by asset');
  for (const [asset, count] of summarizeByAsset(snapshots)) {
    logKeyValue(asset, count);
  }

  logSection('📡 Live Opportunity Radar', 'ranked by cheapest paired entry');
  console.log(renderTableHeader(['Market', 'Pair', 'Edge', 'Liquidity']));
  const ranked = [...snapshots].sort((a, b) => a.combinedAsk - b.combinedAsk);
  ranked.slice(0, 10).forEach((snapshot) => {
    const edge = Math.max(0, 1 - snapshot.combinedAsk);
    console.log(
      renderOpportunityRow(snapshot.prompt.slice(0, 32), snapshot.combinedAsk, edge, snapshot.volumeLabel)
    );
  });

  log('success', 'Live feed snapshot complete.', `${snapshots.length} market(s) hydrated`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log('error', 'Live feed crashed.', message);
  process.exitCode = 1;
});
