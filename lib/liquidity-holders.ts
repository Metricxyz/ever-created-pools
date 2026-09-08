// Step 5: combines lib/liquidity-events.ts's per-(account, bin) share balances with
// lib/bin-state-reader.ts's live on-chain bin reserves/totals and tokens.jsonc's prices into
// outputs/liquidity-holders.json — one entry per account still holding shares anywhere, with
// their position (bin-by-bin share counts + an estimated USD value) in every pool they're in.
//
// A bin's value is estimated the same way significant-pools.ts estimates a pool's (decimals +
// priceUsd from tokens.jsonc — an ESTIMATE, not meant to be precise), from its CURRENT on-chain
// reserves rather than replayed history. Reserves come back "scaled" (normalized to a common
// internal precision so bins of different-decimal tokens compare on equal footing) — descaled
// back to real token amounts via `10^(internalDecimals - tokenDecimals)`, internalDecimals being
// max(18, token0Decimals, token1Decimals). This is MetricOmmPoolFactory's own
// `_getScaleMultipliers` formula (confirmed empirically against real deployed pools'
// getImmutables()), computed here directly from tokens.jsonc's decimals rather than an extra
// on-chain call. An account's share of a bin's value is (their shares / the bin's live total
// shares) — a plain fraction, not itself an approximation, since both numbers come from the same
// live/replayed-to-date state.
//
// computeLiquidityHolders() is a pure getter — no I/O at all, just data in, data out. Read the
// inputs with lib/liquidity-events.ts's scanLiquidityEventsPhase(), lib/bin-state-reader.ts's
// fetchBinStatesPhase(), and lib/tokens-file.ts's readTokensFile(); persist the output with this
// module's own writeLiquidityHoldersFile() below.
import { mkdir, writeFile } from "node:fs/promises";
import type { Address } from "viem";
import { tokenValueUsd } from "./significant-pools.ts";
import { LIQUIDITY_HOLDERS_PATH, OUTPUTS_DIR } from "./paths.ts";
import type {
  AccountBinShares,
  BinPosition,
  BinState,
  ChainTokens,
  FactoryBalances,
  LiquidityHolder,
  PoolPosition,
  TokenMetadata,
} from "./types.ts";

function scaleMultiplier(internalDecimals: number, decimals: number): bigint {
  return 10n ** BigInt(internalDecimals - decimals);
}

// realAmount = scaledAmount / 10^(internalDecimals - decimals); dividing this way (rather than
// via Number()) keeps full BigInt precision right up to the final priceUsd multiplication.
function descaledBalance(scaled: bigint, internalDecimals: number, decimals: number): string {
  const divisor = scaleMultiplier(internalDecimals, decimals);
  return (scaled / divisor).toString();
}

export interface LiquidityHoldersResult {
  totalAccountBinPositions: number;
  distinctAccounts: number;
  distinctPoolPositions: number;
  binsWithUnknownValue: number;
}

export interface LiquidityHoldersComputation {
  result: LiquidityHolder[];
  stats: LiquidityHoldersResult;
}

export function computeLiquidityHolders(
  accountBinShares: AccountBinShares[],
  binStates: BinState[],
  balances: FactoryBalances[],
  tokenChains: ChainTokens[],
): LiquidityHoldersComputation {
  const tokenLookup = new Map<string, TokenMetadata>(); // key: `${chainId}:${address.toLowerCase()}`
  for (const chain of tokenChains) {
    for (const token of chain.tokens) tokenLookup.set(`${chain.chainId}:${token.address.toLowerCase()}`, token);
  }

  const poolTokens = new Map<string, { token0: Address; token1: Address }>(); // key: `${chainId}:${pool.toLowerCase()}`
  for (const factory of balances) {
    for (const chain of factory.chains) {
      for (const pool of chain.pools) {
        poolTokens.set(`${chain.chainId}:${pool.pool.toLowerCase()}`, { token0: pool.token0, token1: pool.token1 });
      }
    }
  }

  const binStateByKey = new Map<string, BinState>(); // key: `${chainId}:${pool.toLowerCase()}:${bin}`
  for (const bs of binStates) binStateByKey.set(`${bs.chainId}:${bs.pool.toLowerCase()}:${bs.bin}`, bs);

  let binsWithUnknownValue = 0;
  const binValueCache = new Map<string, number | null>();
  function binValueUsd(chainId: number, pool: Address, bin: number): number | null {
    const key = `${chainId}:${pool.toLowerCase()}:${bin}`;
    if (binValueCache.has(key)) return binValueCache.get(key)!;

    const bs = binStateByKey.get(key);
    const tokens = poolTokens.get(`${chainId}:${pool.toLowerCase()}`);
    if (!bs || !tokens) {
      binValueCache.set(key, null);
      return null;
    }

    const t0 = tokenLookup.get(`${chainId}:${tokens.token0.toLowerCase()}`);
    const t1 = tokenLookup.get(`${chainId}:${tokens.token1.toLowerCase()}`);
    const dec0 = t0?.decimals ?? null;
    const dec1 = t1?.decimals ?? null;
    let value: number | null = null;
    if (dec0 != null && dec1 != null) {
      const internalDecimals = Math.max(18, dec0, dec1);
      const value0 = tokenValueUsd(descaledBalance(BigInt(bs.token0BalanceScaled), internalDecimals, dec0), dec0, t0?.priceUsd);
      const value1 = tokenValueUsd(descaledBalance(BigInt(bs.token1BalanceScaled), internalDecimals, dec1), dec1, t1?.priceUsd);
      if (value0 != null || value1 != null) value = (value0 ?? 0) + (value1 ?? 0);
    }
    if (value == null) binsWithUnknownValue++;
    binValueCache.set(key, value);
    return value;
  }

  const byAccount = new Map<string, Map<string, PoolPosition>>(); // account -> `${chainId}:${pool}` -> position
  for (const s of accountBinShares) {
    const accountKey = s.account.toLowerCase();
    const poolKey = `${s.chainId}:${s.pool.toLowerCase()}`;

    let poolsForAccount = byAccount.get(accountKey);
    if (!poolsForAccount) {
      poolsForAccount = new Map();
      byAccount.set(accountKey, poolsForAccount);
    }
    let position = poolsForAccount.get(poolKey);
    if (!position) {
      position = { pool: s.pool, chainId: s.chainId, estimatedValueUsd: null, binPositions: [] };
      poolsForAccount.set(poolKey, position);
    }
    position.binPositions.push({ bin: s.bin, shares: s.shares });

    const bs = binStateByKey.get(`${s.chainId}:${s.pool.toLowerCase()}:${s.bin}`);
    const totalValue = binValueUsd(s.chainId, s.pool, s.bin);
    if (bs && totalValue != null && BigInt(bs.totalShares) > 0n) {
      const fraction = Number(BigInt(s.shares)) / Number(BigInt(bs.totalShares));
      position.estimatedValueUsd = (position.estimatedValueUsd ?? 0) + fraction * totalValue;
    }
  }

  const result: LiquidityHolder[] = [...byAccount.entries()]
    .map(([accountKey, poolsForAccount]): LiquidityHolder => {
      const positions = [...poolsForAccount.values()].sort(
        (a, b) => a.chainId - b.chainId || a.pool.localeCompare(b.pool),
      );
      for (const p of positions) p.binPositions.sort((a: BinPosition, b: BinPosition) => a.bin - b.bin);
      return { account: accountKey as Address, positions };
    })
    .sort((a, b) => a.account.localeCompare(b.account));

  const distinctPoolPositions = result.reduce((sum, h) => sum + h.positions.length, 0);

  return {
    result,
    stats: {
      totalAccountBinPositions: accountBinShares.length,
      distinctAccounts: result.length,
      distinctPoolPositions,
      binsWithUnknownValue,
    },
  };
}

export async function writeLiquidityHoldersFile(result: LiquidityHolder[]): Promise<void> {
  await mkdir(OUTPUTS_DIR, { recursive: true });
  await writeFile(LIQUIDITY_HOLDERS_PATH, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote outputs/liquidity-holders.json`);
}
