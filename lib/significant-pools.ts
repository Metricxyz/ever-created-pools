// Step 4: combines outputs/pools-with-balances.json + tokens.jsonc (pure data transform, no
// RPC/network calls) into outputs/significant-pools.json — the same
// grouped-by-factory-then-chain shape, but filtered and sorted for relevance.
//
// A pool is DROPPED if both balance0 and balance1 are "0" (definitely empty, regardless of
// whether prices are known). Otherwise its USD value is computed as
// (balance0 / 10^decimals0 * priceUsd0) + (balance1 / 10^decimals1 * priceUsd1) using
// tokens.jsonc's decimals/priceUsd (this is an ESTIMATE, not meant to be precise — same caveat as
// tokens.jsonc's priceUsd itself). If BOTH token prices are known, a pool is also dropped when
// that value is under MIN_VALUE_USD. If EITHER token's price (or balance, in the rare "ERROR"
// case from step 2's balance-fetching phase) is unknown, the pool's value can't be confidently
// computed, so it is kept regardless of threshold and placed at the end.
//
// Sorting is scoped per (factory, chain) group, not globally: within each group, known-value
// pools come first sorted by value descending, then unknown-value pools (in their original
// order) after them. Groups themselves keep pools-with-balances.json's existing factory/chain
// ordering.
//
// computeSignificantPools() is a pure getter — no I/O at all, just data in, data out. Read the
// inputs with lib/balances-file.ts's readBalancesFile() and lib/tokens-file.ts's readTokensFile();
// persist the output with this module's own writeSignificantPools().
import { mkdir, writeFile } from "node:fs/promises";
import { OUTPUTS_DIR, SIGNIFICANT_POOLS_PATH } from "./paths.ts";
import type { ChainTokens, FactoryBalances, SignificantFactory, SignificantPool, TokenMetadata } from "./types.ts";

const MIN_VALUE_USD = 10;

function tokenValueUsd(balance: string, decimals: number | null, priceUsd: number | null | undefined): number | null {
  if (balance === "ERROR" || decimals == null || priceUsd == null) return null;
  const raw = Number(balance);
  if (!Number.isFinite(raw)) return null;
  return (raw / 10 ** decimals) * priceUsd;
}

export interface SignificantPoolsResult {
  totalIn: number;
  droppedZeroBalance: number;
  droppedBelowThreshold: number;
  keptKnown: number;
  keptUnknown: number;
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
  let droppedZeroBalance = 0;
  let droppedBelowThreshold = 0;
  let keptKnown = 0;
  let keptUnknown = 0;

  const result: SignificantFactory[] = [];

  for (const factory of balances) {
    const outFactory: SignificantFactory = { factory: factory.factory, chains: [] };

    for (const chain of factory.chains) {
      const known: SignificantPool[] = [];
      const unknown: SignificantPool[] = [];

      for (const p of chain.pools) {
        totalIn++;

        if (p.balance0 === "0" && p.balance1 === "0") {
          droppedZeroBalance++;
          continue;
        }

        const t0 = tokenLookup.get(`${chain.chainId}:${p.token0.toLowerCase()}`);
        const t1 = tokenLookup.get(`${chain.chainId}:${p.token1.toLowerCase()}`);
        const value0 = tokenValueUsd(p.balance0, t0?.decimals ?? null, t0?.priceUsd);
        const value1 = tokenValueUsd(p.balance1, t1?.decimals ?? null, t1?.priceUsd);

        if (value0 !== null && value1 !== null) {
          const valueUsd = value0 + value1;
          if (valueUsd < MIN_VALUE_USD) {
            droppedBelowThreshold++;
            continue;
          }
          known.push({ ...p, valueUsd });
          keptKnown++;
        } else {
          unknown.push({ ...p, valueUsd: null });
          keptUnknown++;
        }
      }

      if (known.length === 0 && unknown.length === 0) continue;

      known.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
      outFactory.chains.push({ chainId: chain.chainId, pools: [...known, ...unknown] });
    }

    if (outFactory.chains.length > 0) result.push(outFactory);
  }

  return { result, stats: { totalIn, droppedZeroBalance, droppedBelowThreshold, keptKnown, keptUnknown } };
}

export async function writeSignificantPools(result: SignificantFactory[]): Promise<void> {
  await mkdir(OUTPUTS_DIR, { recursive: true });
  await writeFile(SIGNIFICANT_POOLS_PATH, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote outputs/significant-pools.json`);
}
