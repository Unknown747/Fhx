# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

---

## PolyHFT-Autotrading-V3 (`artifacts/poly/`)

TypeScript autotrading bot for Polymarket binary markets (Polygon mainnet, USDC). Standalone package — not part of the Express/Drizzle stack above.

### Architecture

| Layer | File | Purpose |
|---|---|---|
| Entry | `src/index.ts` | Orchestrates one trading cycle; paper/live mode guard |
| Config | `src/config.ts` | YAML + env parsing; `RiskConfig`, `RuntimeConfig` |
| Connector | `src/connectors/polymarket.ts` | Market snapshot types + builder |
| Connector | `src/connectors/polymarketApi.ts` | Live read-only Gamma + CLOB order book feed |
| Connector | `src/connectors/clobOrderClient.ts` | **Real order signing + submission** via `@polymarket/clob-client` |
| Risk | `src/risk/engine.ts` | Config-driven risk gates (drawdown, gross exposure, daily loss, etc.) |
| Execution | `src/execution/engine.ts` | Signal aggregation → risk approval → paper/live order routing |
| Strategies | `src/strategies/` | 5 strategies: `dualBuyParity`, `curveArb`, `momentum`, `meanReversion`, `metaConfluence` |
| Backtesting | `src/backtesting/engine.ts` | Historical replay engine |
| Tests | `src/test/fullTest.ts` | 260+ assertion integration test suite |

### Key npm scripts

```
npm run build       # tsc compile
npm start           # run one cycle (paper/live mode from YAML + .env)
npm run test:full   # run 260+ assertion integration test suite
npm run live        # live market data feed (read-only)
npm run backtest    # historical backtest
```

### Important files

- `config/base.yaml` — market config (slugs, token IDs, risk params, mode)
- `.env.example` — all required env vars documented; copy to `.env`
- `src/connectors/clobOrderClient.ts` — ethers v6 + `@polymarket/clob-client` v5 adapter

### Live trading checklist

1. Copy `.env.example` → `.env` and fill in `PRIVATE_KEY` + API credentials
2. Replace all `REPLACE_WITH_REAL_CLOB_TOKEN_ID` in `config/base.yaml` with live token IDs from Gamma API
3. Set `app.mode: live` in `config/base.yaml`
4. Set `DRY_RUN=false` in `.env` **only** after validating paper behaviour
5. Confirm `POLYMARKET_SIGNATURE_TYPE` matches your wallet type (0=EOA, 1=POLY_PROXY, 2=Gnosis Safe)

### Security notes

- `redeem-onchain-sdk` was removed (supply-chain attack vector — `proxy.js` loaded before secrets)
- `autopush` script removed (leaked repo state)
- `PRIVATE_KEY` is never logged; credential presence shown as `set`/`not set`
- `DRY_RUN` defaults to `true` — cannot place real orders without explicit opt-in
