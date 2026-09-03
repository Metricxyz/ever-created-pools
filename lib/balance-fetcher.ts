// Step 2, phase (b): batch-fetches current token0/token1 balances for discovered pools via
// Multicall3. Purely a getter — does not write to disk; call writeBalancesFile() (in
// lib/balances-file.ts) separately to persist the result.
import { isAddressEqual, type Address, type PublicClient } from "viem";
import { withRpcSlot } from "./rpc.ts";
import { skipReason } from "./env.ts";
import { BALANCE_OF_ABI, MULTICALL3_ADDRESS } from "./abis.ts";
import type { DiscoveredPool, FactoryBalances, PoolBalance } from "./types.ts";

// Named to avoid repeating this shape at every call site below (fetchBalances' param, its local
// batch/item, and the per-(factory,chain) grouping) — without the name it's easy to mistake for
// the richer DiscoveredPool it's derived from.
type PoolTokenTriple = { pool: Address; token0: Address; token1: Address };

// One multicall per (factory, chain) group, chunked to CHUNK_CALLS to keep any single response
// reasonably sized. Falls back to individual balanceOf calls (still concurrency-limited via
// withRpcSlot) if Multicall3 itself errors for any reason.
async function fetchBalances(client: PublicClient, entries: PoolTokenTriple[]): Promise<PoolBalance[]> {
  const CHUNK_CALLS = 1000; // 500 pools per multicall batch (2 calls each)
  const rows: PoolBalance[] = [];

  for (let i = 0; i < entries.length; i += CHUNK_CALLS / 2) {
    const batch = entries.slice(i, i + CHUNK_CALLS / 2);
    const contracts = batch.flatMap((e) => [
      { address: e.token0, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [e.pool] } as const,
      { address: e.token1, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [e.pool] } as const,
    ]);

    let results: Array<{ status: "success" | "failure"; result?: unknown }>;
    try {
      results = await withRpcSlot(() =>
        client.multicall({ contracts, multicallAddress: MULTICALL3_ADDRESS, allowFailure: true }),
      );
    } catch (err) {
      const e = err as { shortMessage?: string; details?: string };
      console.warn(
        `  multicall failed for a batch, falling back to individual calls: ${(e?.details || e?.shortMessage || "unknown error").slice(0, 150)}`,
      );
      results = await Promise.all(
        contracts.map(async (c) => {
          try {
            const result = await withRpcSlot(() =>
              client.readContract({ address: c.address, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: c.args }),
            );
            return { status: "success" as const, result };
          } catch {
            return { status: "failure" as const };
          }
        }),
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j]!;
      const r0 = results[j * 2];
      const r1 = results[j * 2 + 1];
      rows.push({
        pool: item.pool,
        token0: item.token0,
        token1: item.token1,
        balance0: r0?.status === "success" ? String(r0.result) : "ERROR",
        balance1: r1?.status === "success" ? String(r1.result) : "ERROR",
      });
    }
  }

  return rows;
}

type FactoryChainGroup = { factory: Address; chainId: number; entries: PoolTokenTriple[] };

export async function fetchBalancesPhase(
  pools: DiscoveredPool[],
  getClient: (chainId: number) => PublicClient | null,
): Promise<FactoryBalances[]> {
  const byFactoryChain = new Map<string, FactoryChainGroup>();
  for (const p of pools) {
    const key = `${p.factory.toLowerCase()}_${p.chainId}`;
    const group: FactoryChainGroup = byFactoryChain.get(key) ?? { factory: p.factory, chainId: p.chainId, entries: [] };
    group.entries.push({ pool: p.pool, token0: p.token0, token1: p.token1 });
    byFactoryChain.set(key, group);
  }

  // Deterministic order: factory address, then chainId — not discovery order.
  const groups: FactoryChainGroup[] = [...byFactoryChain.values()].sort(
    (a, b) => a.factory.localeCompare(b.factory) || a.chainId - b.chainId,
  );

  const result: FactoryBalances[] = [];
  let totalPools = 0;

  for (const group of groups) {
    const client = getClient(group.chainId);
    if (!client) {
      console.warn(`skip ${group.factory} on chain ${group.chainId}: ${skipReason(group.chainId)}`);
      continue;
    }

    console.log(`fetching balances for ${group.factory} on chain ${group.chainId} (${group.entries.length} pool(s))...`);
    const pools_: PoolBalance[] = await fetchBalances(client, group.entries);
    totalPools += pools_.length;

    let factoryEntry: FactoryBalances | undefined = result.find((f) => isAddressEqual(f.factory, group.factory));
    if (!factoryEntry) {
      factoryEntry = { factory: group.factory, chains: [] };
      result.push(factoryEntry);
    }
    factoryEntry.chains.push({ chainId: group.chainId, pools: pools_ });
  }

  console.log(`(b) Fetched balances for ${totalPools} pool(s) across ${result.length} factory/factories.`);

  return result;
}
