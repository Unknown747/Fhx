# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Single artifact: PolyHFT autotrading bot.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages

---

## PolyHFT-Autotrading-V3 (`artifacts/poly/`)

TypeScript autotrading bot for Polymarket binary markets (Polygon mainnet, USDC).

### Architecture

| Layer | File | Purpose |
|---|---|---|
| Entry | `src/index.ts` | Continuous loop (`runLoop()`); discovery, snapshots, execute, report |
| Config | `src/config.ts` | YAML + env parsing; `RiskConfig`, `RuntimeConfig` |
| Discovery | `src/connectors/tokenDiscovery.ts` | TTL-cached (3 min) Gamma API slug → tokenId resolver |
| Connector | `src/connectors/polymarket.ts` | Market snapshot types + builder |
| Connector | `src/connectors/polymarketApi.ts` | Live Gamma + CLOB order book feed |
| Connector | `src/connectors/clobOrderClient.ts` | Real order signing + submission via `@polymarket/clob-client` |
| Risk | `src/risk/engine.ts` | 9 risk gates; dynamic slippage based on volume label |
| Execution | `src/execution/engine.ts` | Paired + single-leg paths; `FillTracker` for live order polling |
| Strategies | `src/strategies/` | **7 strategies** (3 paired-entry, 4 single-leg) |
| Backtesting | `src/backtesting/engine.ts` | Full P&L simulation with per-trade reporting |
| Examples | `src/examples/liveMarkets.ts` | Read-only live market feed CLI |
| Tests | `src/test/fullTest.ts` | 367+ assertion integration test suite |

### Strategies

| Strategy | Type | Trigger |
|---|---|---|
| `dualBuyParity` | paired-entry | Any combinedAsk < 1; confidence scales with edge |
| `volumeImbalance` | paired-entry | Strong order-book imbalance (>12%) + edge > 1.5% |
| `resolutionArb` | paired-entry | Deep discount: edge > 4.5% |
| `curveArb` | single-leg | Binary identity dislocation ≥ 3% |
| `momentum` | single-leg | Strong directional imbalance > 18% |
| `meanReversion` | single-leg | Implied probability stretched > 60% → buy cheap side |
| `metaConfluence` | single-leg | Multi-indicator weighted score ≥ 60% |

### Key npm scripts

```
npm run build       # tsc compile to dist/
npm start           # run continuous loop (paper/live/backtest from YAML + .env)
npm run test:full   # 367+ assertion integration test suite
npm run live        # read-only live market data feed
```

### Important files

- `config/base.yaml` — 9 markets (BTC/ETH/SOL/XRP/DOGE/BNB), risk params, mode
- `.env.example` — all required env vars documented
- `src/connectors/clobOrderClient.ts` — ethers v6 + `@polymarket/clob-client` v5 adapter
- `src/execution/engine.ts` — `FillTracker` polls open orders every 2.5s in live mode

### Live trading checklist

1. Copy `.env.example` → `.env` and fill in `PRIVATE_KEY` + API credentials
2. Token IDs auto-resolved via `TokenDiscoveryService` — no manual config needed
3. Set `app.mode: live` in `config/base.yaml`
4. Set `DRY_RUN=false` in `.env` **only** after validating paper behaviour
5. Confirm `POLYMARKET_SIGNATURE_TYPE` matches wallet type (0=EOA, 1=POLY_PROXY, 2=Gnosis Safe)
6. SIGTERM/SIGINT gracefully cancels all open orders before exit

### Risk engine gates (in order)

1. Size must be positive
2. Price must be in (0, 1)
3. Net edge must be positive after fees + dynamic slippage
4. Confidence must be ≥ minConfidence (default 0.55)
5. Notional ≥ minOrderNotional (default $20)
6. Notional ≤ maxOrderNotional (default $1,500) — capped, not rejected
7. Market exposure limit — capped, not rejected
8. Daily loss circuit breaker
9. Max drawdown circuit breaker

### Dynamic slippage model

| Volume | Extra slippage |
|---|---|
| Unknown | +15 bps |
| < $10K | +40 bps |
| $10K–$20K | +20 bps |
| $20K–$50K | +8 bps |
| ≥ $50K | +0 bps |

### Security notes

- `PRIVATE_KEY` is never logged; credential presence shown as `set ✓`/`MISSING ✗`
- `DRY_RUN` defaults to `true` — cannot place real orders without explicit opt-in
- `redeem-onchain-sdk` removed (supply-chain attack vector)
- `autopush` script removed
