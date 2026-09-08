// Step 5, phase (b): reads each pool's CURRENT on-chain bin state (reserves + total outstanding
// shares) for every bin any account still holds shares in, per lib/liquidity-events.ts. v2-4
// pools go through the deployed MetricOmmPoolDataProvider (its slot math matches their storage
// layout); v1 pools predate that layout, so their bins are read via the pool's own `extsload`
// using the old base slots directly (see OLD_ERA_BIN_SLOTS in lib/abis.ts). Purely a getter —
// does not write to disk.
import { encodeAbiParameters, keccak256, type Address, type PublicClient } from "viem";
import { withRpcSlot } from "./rpc.ts";
import { skipReason } from "./env.ts";
import { readJsonc } from "./jsonc.ts";
import { FACTORIES_JSONC_PATH } from "./paths.ts";
import { DATA_PROVIDER_ABI, DATA_PROVIDER_ADDRESS, EXTSLOAD_ABI, MULTICALL3_ADDRESS, OLD_ERA_BIN_SLOTS } from "./abis.ts";
import type { AccountBinShares, BinState, FactoryEntry } from "./types.ts";

type MulticallResult = { status: "success" | "failure"; result?: unknown };

function oldEraSlot(baseSlot: bigint, bin: number): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: "int16" }, { type: "uint256" }], [bin, baseSlot]));
}

const UINT104_MASK = (1n << 104n) - 1n;

async function fetchDataProviderBinStates(
  client: PublicClient,
  entries: Array<{ pool: Address; bin: number }>,
): Promise<Array<{ token0BalanceScaled: bigint; token1BalanceScaled: bigint; totalShares: bigint }>> {
  const contracts = entries.flatMap((e) => [
    { address: DATA_PROVIDER_ADDRESS, abi: DATA_PROVIDER_ABI, functionName: "binState", args: [e.pool, e.bin] } as const,
    { address: DATA_PROVIDER_ADDRESS, abi: DATA_PROVIDER_ABI, functionName: "binTotalShares", args: [e.pool, e.bin] } as const,
  ]);
  const results: MulticallResult[] = await withRpcSlot(() =>
    client.multicall({ contracts, multicallAddress: MULTICALL3_ADDRESS, allowFailure: true }),
  );
  return entries.map((_, i) => {
    const binStateResult = results[i * 2];
    const totalSharesResult = results[i * 2 + 1];
    const [token0BalanceScaled, token1BalanceScaled] =
      binStateResult?.status === "success" ? (binStateResult.result as [bigint, bigint, number, number, number]) : [0n, 0n];
    const totalShares = totalSharesResult?.status === "success" ? (totalSharesResult.result as bigint) : 0n;
    return { token0BalanceScaled, token1BalanceScaled, totalShares };
  });
}

async function fetchOldEraBinStates(
  client: PublicClient,
  entries: Array<{ pool: Address; bin: number }>,
): Promise<Array<{ token0BalanceScaled: bigint; token1BalanceScaled: bigint; totalShares: bigint }>> {
  const contracts = entries.flatMap((e) => [
    { address: e.pool, abi: EXTSLOAD_ABI, functionName: "extsload", args: [oldEraSlot(OLD_ERA_BIN_SLOTS.binsStates, e.bin)] } as const,
    {
      address: e.pool,
      abi: EXTSLOAD_ABI,
      functionName: "extsload",
      args: [oldEraSlot(OLD_ERA_BIN_SLOTS.binsTotalShares, e.bin)],
    } as const,
  ]);
  const results: MulticallResult[] = await withRpcSlot(() =>
    client.multicall({ contracts, multicallAddress: MULTICALL3_ADDRESS, allowFailure: true }),
  );
  return entries.map((_, i) => {
    const binStateSlot = results[i * 2];
    const totalSharesSlot = results[i * 2 + 1];
    const packed = binStateSlot?.status === "success" ? BigInt(binStateSlot.result as `0x${string}`) : 0n;
    const totalShares = totalSharesSlot?.status === "success" ? BigInt(totalSharesSlot.result as `0x${string}`) : 0n;
    return { token0BalanceScaled: packed & UINT104_MASK, token1BalanceScaled: (packed >> 104n) & UINT104_MASK, totalShares };
  });
}

export async function fetchBinStatesPhase(
  accountBinShares: AccountBinShares[],
  getClient: (chainId: number) => PublicClient | null,
): Promise<BinState[]> {
  const factories = await readJsonc<FactoryEntry[]>(FACTORIES_JSONC_PATH);
  const abiVersionByFactory = new Map<string, number>();
  for (const entry of factories) abiVersionByFactory.set(entry.factory.toLowerCase(), entry.abiVersion);

  // Dedup to one (chainId, pool, bin) triple regardless of how many accounts hold shares there.
  const uniqueBins = new Map<string, { factory: Address; chainId: number; pool: Address; bin: number }>();
  for (const s of accountBinShares) {
    uniqueBins.set(`${s.chainId}:${s.pool.toLowerCase()}:${s.bin}`, { factory: s.factory, chainId: s.chainId, pool: s.pool, bin: s.bin });
  }

  const byChain = new Map<number, Array<{ factory: Address; pool: Address; bin: number }>>();
  for (const entry of uniqueBins.values()) {
    const list = byChain.get(entry.chainId) ?? [];
    list.push(entry);
    byChain.set(entry.chainId, list);
  }

  const CHUNK = 500; // 500 bins per multicall batch (2 calls each)
  const result: BinState[] = [];

  for (const [chainId, entries] of byChain) {
    const client = getClient(chainId);
    if (!client) {
      console.warn(`skip ${entries.length} bin(s) on chain ${chainId}: ${skipReason(chainId)}`);
      continue;
    }

    const v1Entries = entries.filter((e) => abiVersionByFactory.get(e.factory.toLowerCase()) === 1);
    const v2plusEntries = entries.filter((e) => abiVersionByFactory.get(e.factory.toLowerCase()) !== 1);

    console.log(`(b) reading bin state for ${entries.length} bin(s) on chain ${chainId}...`);

    for (let i = 0; i < v2plusEntries.length; i += CHUNK) {
      const batch = v2plusEntries.slice(i, i + CHUNK);
      const states = await fetchDataProviderBinStates(client, batch);
      for (let j = 0; j < batch.length; j++) {
        const e = batch[j]!;
        const s = states[j]!;
        result.push({
          factory: e.factory,
          chainId,
          pool: e.pool,
          bin: e.bin,
          token0BalanceScaled: s.token0BalanceScaled.toString(),
          token1BalanceScaled: s.token1BalanceScaled.toString(),
          totalShares: s.totalShares.toString(),
        });
      }
    }

    for (let i = 0; i < v1Entries.length; i += CHUNK) {
      const batch = v1Entries.slice(i, i + CHUNK);
      const states = await fetchOldEraBinStates(client, batch);
      for (let j = 0; j < batch.length; j++) {
        const e = batch[j]!;
        const s = states[j]!;
        result.push({
          factory: e.factory,
          chainId,
          pool: e.pool,
          bin: e.bin,
          token0BalanceScaled: s.token0BalanceScaled.toString(),
          token1BalanceScaled: s.token1BalanceScaled.toString(),
          totalShares: s.totalShares.toString(),
        });
      }
    }
  }

  console.log(`(b) Read bin state for ${result.length} bin(s) across ${byChain.size} chain(s).`);
  return result;
}
