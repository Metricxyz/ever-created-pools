// Step 2, phase (c): batch-fetches name()/symbol()/decimals() for every unique token discovered
// pools reference. Purely a getter — does not write to disk; call writeTokensFile() (in
// lib/tokens-file.ts) separately to persist tokens.jsonc.
import type { Address, PublicClient } from "viem";
import { withRpcSlot } from "./rpc.ts";
import { skipReason } from "./env.ts";
import { ERC20_METADATA_ABI, MULTICALL3_ADDRESS } from "./abis.ts";
import type { ChainTokens, DiscoveredPool, TokenMetadata } from "./types.ts";

// Named so it's not repeated at every results[i] access below — each index may be absent
// (multicall allowFailure) so callers must check .status before trusting .result.
type MulticallResult = { status: "success" | "failure"; result?: unknown };

async function fetchTokenMetadata(client: PublicClient, addresses: Address[]): Promise<TokenMetadata[]> {
  const contracts = addresses.flatMap((addr) => [
    { address: addr, abi: ERC20_METADATA_ABI, functionName: "name" } as const,
    { address: addr, abi: ERC20_METADATA_ABI, functionName: "symbol" } as const,
    { address: addr, abi: ERC20_METADATA_ABI, functionName: "decimals" } as const,
  ]);

  let results: MulticallResult[];
  try {
    results = await withRpcSlot(() =>
      client.multicall({ contracts, multicallAddress: MULTICALL3_ADDRESS, allowFailure: true }),
    );
  } catch (err) {
    const e = err as { shortMessage?: string; details?: string };
    console.warn(`  multicall failed, falling back to individual calls: ${(e?.details || e?.shortMessage || "unknown error").slice(0, 150)}`);
    results = await Promise.all(
      contracts.map(async (c) => {
        try {
          const result = await withRpcSlot(() => client.readContract(c));
          return { status: "success" as const, result };
        } catch {
          return { status: "failure" as const };
        }
      }),
    );
  }

  return addresses.map((address, i) => {
    const name: MulticallResult | undefined = results[i * 3];
    const symbol: MulticallResult | undefined = results[i * 3 + 1];
    const decimals: MulticallResult | undefined = results[i * 3 + 2];
    return {
      address,
      name: name?.status === "success" ? (name.result as string) : null,
      symbol: symbol?.status === "success" ? (symbol.result as string) : null,
      decimals: decimals?.status === "success" ? Number(decimals.result) : null,
    };
  });
}

export async function fetchMetadataPhase(
  pools: DiscoveredPool[],
  getClient: (chainId: number) => PublicClient | null,
): Promise<ChainTokens[]> {
  const tokensByChain = new Map<number, Set<string>>();
  for (const p of pools) {
    const set = tokensByChain.get(p.chainId) ?? new Set<string>();
    set.add(p.token0);
    set.add(p.token1);
    tokensByChain.set(p.chainId, set);
  }

  const chainIds = [...tokensByChain.keys()].sort((a, b) => a - b);
  const result: ChainTokens[] = [];
  let totalTokens = 0;
  let totalUnknownFields = 0;

  for (const chainId of chainIds) {
    const addresses = [...tokensByChain.get(chainId)!].sort() as Address[];
    if (addresses.length === 0) continue;

    const client = getClient(chainId);
    if (!client) {
      console.warn(`skip chain ${chainId}: ${skipReason(chainId)} (${addresses.length} token(s) unresolved)`);
      result.push({ chainId, tokens: addresses.map((address) => ({ address, name: null, symbol: null, decimals: null })) });
      continue;
    }

    console.log(`fetching metadata for ${addresses.length} token(s) on chain ${chainId}...`);
    const tokens = await fetchTokenMetadata(client, addresses);
    for (const t of tokens) {
      if (t.name === null || t.symbol === null || t.decimals === null) {
        totalUnknownFields++;
        console.warn(`  ${t.address}: name=${t.name ?? "?"} symbol=${t.symbol ?? "?"} decimals=${t.decimals ?? "?"}`);
      }
    }
    totalTokens += tokens.length;
    result.push({ chainId, tokens });
  }

  console.log(`(c) Fetched metadata for ${totalTokens} token(s) across ${result.length} chain(s).`);
  if (totalUnknownFields) {
    console.log(`${totalUnknownFields} token(s) have at least one null metadata field — see warnings above.`);
  }

  return result;
}
