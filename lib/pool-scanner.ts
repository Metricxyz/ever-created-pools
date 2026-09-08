// Step 2, phase (a): scans every factory in factories.jsonc for PoolCreated logs and returns the
// discovered pools for the next phases to use. Purely a getter — does not write to disk.
import { isAddressEqual, type AbiEvent, type Address, type PublicClient } from "viem";
import { readFile } from "node:fs/promises";
import { getLogsAdaptive } from "./adaptive-logs.ts";
import { skipReason } from "./env.ts";
import { readJsonc } from "./jsonc.ts";
import { FACTORIES_JSONC_PATH, abiPath } from "./paths.ts";
import type { CliArgs } from "./cli.ts";
import type { DiscoveredPool, FactoryEntry } from "./types.ts";

export async function scanPools(args: CliArgs, getClient: (chainId: number) => PublicClient | null): Promise<DiscoveredPool[]> {
  const factories = await readJsonc<FactoryEntry[]>(FACTORIES_JSONC_PATH);
  const defaultFromBlock = BigInt(process.env.DEFAULT_FROM_BLOCK ?? "0");
  const CONCURRENCY = Number(process.env.CONCURRENCY ?? "8");

  const abiCache = new Map<number, AbiEvent>();
  async function loadFactoryAbi(version: number): Promise<AbiEvent> {
    const cached = abiCache.get(version);
    if (cached) return cached;
    const abi = JSON.parse(await readFile(abiPath(version), "utf8")) as AbiEvent[];
    const poolCreatedEvent: AbiEvent | undefined = abi.find((e) => e.type === "event" && e.name === "PoolCreated");
    if (!poolCreatedEvent) throw new Error(`No PoolCreated event in abis/${version}/MetricOmmPoolFactory.json`);
    abiCache.set(version, poolCreatedEvent);
    return poolCreatedEvent;
  }

  let scannedCount = 0;
  let skippedCount = 0;
  const discovered: DiscoveredPool[] = [];

  const workItems: Array<{ entry: FactoryEntry; chainId: number }> = [];
  for (const entry of factories) {
    if (args.factory && !isAddressEqual(entry.factory, args.factory)) continue;
    for (const chainId of entry.chainIds) {
      if (args.chains && !args.chains.includes(chainId)) continue;
      workItems.push({ entry, chainId });
    }
  }

  async function processItem({ entry, chainId }: { entry: FactoryEntry; chainId: number }): Promise<void> {
    const client = getClient(chainId);
    if (!client) {
      console.warn(`skip ${entry.factory} on chain ${chainId}: ${skipReason(chainId)}`);
      skippedCount++;
      return;
    }

    const poolCreatedEvent = await loadFactoryAbi(entry.abiVersion);
    // Three-state, not obvious at a glance: a real number (known block), explicit null
    // (recorded as unknown in factories.jsonc), or undefined (deploymentBlocks itself absent).
    const knownBlock: number | null | undefined = entry.deploymentBlocks?.[entry.chainIds.indexOf(chainId)];
    const fromBlock = knownBlock != null ? BigInt(knownBlock) : defaultFromBlock;
    const toBlock = await client.getBlockNumber();

    console.log(`scanning ${entry.factory} on chain ${chainId} (abiVersion ${entry.abiVersion}), blocks ${fromBlock}-${toBlock}...`);

    const { logs, incomplete } = await getLogsAdaptive(client, {
      address: entry.factory,
      event: poolCreatedEvent,
      fromBlock,
      toBlock,
    });

    console.log(`  -> ${entry.factory} on chain ${chainId}: ${logs.length} PoolCreated log(s)`);

    for (const log of logs) {
      const a: Record<string, unknown> = (log as { args?: Record<string, unknown> }).args ?? {};
      const pool = (a.pool ?? a.poolAddress ?? null) as Address | null;
      const token0 = (a.token0 ?? null) as Address | null;
      const token1 = (a.token1 ?? null) as Address | null;
      if (pool && token0 && token1) {
        discovered.push({ factory: entry.factory, chainId, pool, token0, token1 });
      }
    }

    scannedCount++;
    if (incomplete.length) {
      console.warn(`  WARNING: ${incomplete.length} incomplete block range(s) for ${entry.factory} on chain ${chainId}`);
    }
  }

  // Bounded-concurrency worker pool — all (factory, chain) pairs are independent.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < workItems.length) {
      const item = workItems[nextIndex++]!;
      await processItem(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, workItems.length) }, () => worker()));

  console.log(`\n(a) Scanned ${scannedCount} factory/chain pair(s), ${discovered.length} pool(s) total.`);
  if (skippedCount) {
    console.log(`Skipped ${skippedCount} factory/chain pair(s).`);
  }

  return discovered;
}
