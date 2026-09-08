// Step 4: combines outputs/pools-with-balances.json + tokens.jsonc (pure data transform, no
// RPC/network calls) into outputs/significant-pools.json — the same
// grouped-by-factory-then-chain shape, but filtered and sorted for relevance.
//
// Every pool is kept — nothing is dropped from the output. Its USD value is computed as
// (balance0 / 10^decimals0 * priceUsd0) + (balance1 / 10^decimals1 * priceUsd1) using
// tokens.jsonc's decimals/priceUsd (this is an ESTIMATE, not meant to be precise — same caveat as
// tokens.jsonc's priceUsd itself). If only ONE token's price is known, the whole pool's value is
// estimated as 2x that single known side (a rough assumption that the pool holds roughly equal
// value on both sides). If NEITHER token's price is known (or a balance is the "ERROR" sentinel
// from step 2's balance-fetching phase), the value can't be estimated at all.
//
// A pool goes into a chain's `pools` list when it has an estimated value >= MIN_VALUE_USD;
// everything else — both balances zero, a known/estimated value under MIN_VALUE_USD, or a
// value that couldn't be estimated at all — goes into that chain's `other_pools` list instead,
// so nothing is lost, just deprioritized.
//
// Sorting is scoped per (factory, chain) group, not globally: within each group, `pools` is
// sorted by value descending; `other_pools` keeps original order. Groups themselves keep
// pools-with-balances.json's existing factory/chain ordering.
//
// computeSignificantPools() is a pure getter — no I/O at all, just data in, data out. Read the
// inputs with lib/balances-file.ts's readBalancesFile() and lib/tokens-file.ts's readTokensFile();
// persist the output with this module's own writeSignificantPools().
import { mkdir, writeFile } from "node:fs/promises";
import { OUTPUTS_DIR, SIGNIFICANT_POOLS_PATH } from "./paths.ts";
import type { ChainTokens, FactoryBalances, SignificantFactory, SignificantPool, TokenMetadata } from "./types.ts";

const MIN_VALUE_USD = 10;
const SINGLE_TOKEN_ESTIMATE_MULTIPLIER = 2;

function tokenValueUsd(balance: string, decimals: number | null, priceUsd: number | null | undefined): number | null {
  if (balance === "ERROR" || decimals == null || priceUsd == null) return null;
  const raw = Number(balance);
  if (!Number.isFinite(raw)) return null;
  return (raw / 10 ** decimals) * priceUsd;
}

function estimatePoolValueUsd(value0: number | null, value1: number | null): number | null {
  if (value0 !== null && value1 !== null) return value0 + value1;
  if (value0 !== null) return value0 * SINGLE_TOKEN_ESTIMATE_MULTIPLIER;
  if (value1 !== null) return value1 * SINGLE_TOKEN_ESTIMATE_MULTIPLIER;
  return null;
}

export interface SignificantPoolsResult {
  totalIn: number;
  zeroBalance: number;
  belowThreshold: number;
  keptKnown: number;
  otherUnknown: number;
}

export interface SignificantPoolsComputation {
  result: SignificantFactory[];
  stats: SignificantPoolsResult;
}

export function computeSignificantPools(balances: FactoryBalances[], tokenChains: ChainTokens[]): SignificantPoolsComputation {
  const tokenLookup = new Map<string, TokenMetadata>(); // key: `${chainId}:${address.toLowerCase()}`
  for (const chain of tokenChains) {
    for (const token of chain.tokens) {
      tokenLookup.set(`${chain.chainId}:${token.address.toLowerCase()}`, token);
    }
  }

  let totalIn = 0;
  let zeroBalance = 0;
  let belowThreshold = 0;
  let keptKnown = 0;
  let otherUnknown = 0;

  const result: SignificantFactory[] = [];

  for (const factory of balances) {
    const outFactory: SignificantFactory = { factory: factory.factory, chains: [] };

    for (const chain of factory.chains) {
      const known: SignificantPool[] = [];
      const other: SignificantPool[] = [];

      for (const p of chain.pools) {
        totalIn++;

        if (p.balance0 === "0" && p.balance1 === "0") {
          zeroBalance++;
          other.push({ ...p, valueUsd: 0 });
          continue;
        }

        const t0 = tokenLookup.get(`${chain.chainId}:${p.token0.toLowerCase()}`);
        const t1 = tokenLookup.get(`${chain.chainId}:${p.token1.toLowerCase()}`);
        const value0 = tokenValueUsd(p.balance0, t0?.decimals ?? null, t0?.priceUsd);
        const value1 = tokenValueUsd(p.balance1, t1?.decimals ?? null, t1?.priceUsd);
        const valueUsd = estimatePoolValueUsd(value0, value1);

        if (valueUsd === null) {
          otherUnknown++;
          other.push({ ...p, valueUsd: null });
        } else if (valueUsd < MIN_VALUE_USD) {
          belowThreshold++;
          other.push({ ...p, valueUsd });
        } else {
          keptKnown++;
          known.push({ ...p, valueUsd });
        }
      }

      if (known.length === 0 && other.length === 0) continue;

      known.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
      outFactory.chains.push({ chainId: chain.chainId, pools: known, other_pools: other });
    }

    if (outFactory.chains.length > 0) result.push(outFactory);
  }

  return { result, stats: { totalIn, zeroBalance, belowThreshold, keptKnown, otherUnknown } };
}

export async function writeSignificantPools(result: SignificantFactory[]): Promise<void> {
  await mkdir(OUTPUTS_DIR, { recursive: true });
  await writeFile(SIGNIFICANT_POOLS_PATH, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote outputs/significant-pools.json`);
}
