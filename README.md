# Metric factory deployments — machine-readable

## Purpose

Finds pools under old/deprecated Metric `PoolFactory` deployments that still hold money —
liquidity or accrued fees left behind — so they can be identified as candidates for cleanup
(withdrawing liquidity, claiming fees). `outputs/significant-pools.json` is the actionable end
result: every pool worth looking at, factory by factory, chain by chain.

## How to use

```bash
npm install                  # installs viem + typescript
cp .env.example .env         # fill in ALCHEMY_API_KEY

npm run 2-pools-with-balances   # scan PoolCreated logs, fetch balances + token metadata
npm run 3-get-token-prices      # add priceUsd estimates (DeFiLlama, then CoinGecko fallback)
npm run 4-get-significant-pools # filter/sort down to outputs/significant-pools.json
npm run 5-get-liquidity-holders # who still holds liquidity -> outputs/liquidity-holders.json
```

Steps 2, 3, and 5 can be scoped: `--chains 1,8453` and/or `--factory 0x...`.

Before any of this can find anything, `factories.jsonc` (and `abis/<n>/` if a new ABI shape is
introduced) must list the factory — see Design below. `npm run 1-prepare-factories` and
`npm run 3a-fill-remaining-prices` are reminders, not scripts — there's nothing to run for those
steps, they're manual.

If a token's `priceUsd` is still `null` after step 3, fill it in by hand in `tokens.jsonc`
(`//`/`/* */` comments allowed — annotate the source). Hand-filled prices are never lost:
step 2 only refreshes name/symbol/decimals, and step 3 only overwrites a price when it actually
finds a fresh one.

## Design

**Two hand-maintained inputs, nothing else auto-discovered:**
- `factories.jsonc` — every `MetricOmmPoolFactory` ever deployed: `{ factory, chainIds,
  eventSignature, abiVersion, deploymentBlocks }`. Add an entry by hand for each new deployment;
  `deploymentBlocks` (per chain, from a block explorer or `eth_getCode` binary search) lets the
  scanner skip straight to the deployment block instead of genesis — `null` falls back to
  `DEFAULT_FROM_BLOCK`.
- `abis/<abiVersion>/` — compiler-output ABI JSON, one folder per distinct `PoolCreated` shape.
  Add a new version when the event signature changes; reference it from `factories.jsonc`.

**Pipeline, each step reading only what the last one wrote:**
1. Scan every factory/chain pair for `PoolCreated` logs (adaptive `eth_getLogs`, splits the block
   range only if a call actually fails on size/timeout).
2. Fetch `token0`/`token1` balances via Multicall3 → `outputs/pools-with-balances.json`.
3. Fetch `name`/`symbol`/`decimals` on-chain, then `priceUsd` (DeFiLlama primary, CoinGecko
   fallback) → `tokens.jsonc`.
4. Compute `valueUsd` per pool (if only one token's price is known, estimate the pool's value as
   2x that side) and split each chain into `pools` (>= $10 estimated value, sorted descending) and
   `other_pools` (zero balances, below $10, or value couldn't be estimated) →
   `outputs/significant-pools.json`.
5. Replay every pool's `LiquidityAdded`/`LiquidityRemoved` (abiVersion 2-4) or
   `LiquidityModified` (abiVersion 1) events and net them per (account, bin) — the only way to
   learn who holds shares, since no version exposes an on-chain holder list. Combine with each
   bin's CURRENT on-chain reserves/total-shares (via the deployed `MetricOmmPoolDataProvider` for
   abiVersion 2-4, or hand-rolled `extsload` reads for abiVersion 1, which predates that
   contract's storage layout — see `lib/abis.ts`'s `OLD_ERA_BIN_SLOTS`) to estimate each holder's
   USD value per pool → `outputs/liquidity-holders.json`. This intentionally excludes any
   protocol/performance fees accrued in the pool's raw token balance — those aren't attributable
   to any bin, so they don't belong to any liquidity holder.

**Code organization:** `scripts/<step>.ts` are thin CLI entry points — parse args, call `lib/`,
print results. Every `lib/` function either **gets** (computes/fetches, returns data, no disk I/O)
or **writes** (persists already-computed data) — never both; scripts call get-then-write
explicitly. See each `lib/*.ts` file's header comment for what it owns.
