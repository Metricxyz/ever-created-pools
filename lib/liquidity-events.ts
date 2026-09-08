// Step 5, phase (a): replays every pool's LiquidityAdded/LiquidityRemoved (abiVersion 2-4) or
// LiquidityModified (abiVersion 1) events and nets them into a per-(pool, account, salt, bin)
// share balance — the only way to learn who holds shares at all, since no version exposes a way
// to enumerate holders on-chain. (account, salt, bin) is exactly the on-chain position key
// (`_positionBinShares`'s mapping key), so this is also exactly what's needed to redeem a
// specific position later. Purely a getter — does not write to disk.
import { readFile } from "node:fs/promises";
import type { AbiEvent, Address, PublicClient } from "viem";
import { getLogsAdaptive } from "./adaptive-logs.ts";
import { skipReason } from "./env.ts";
import { readJsonc } from "./jsonc.ts";
import { FACTORIES_JSONC_PATH, poolAbiPath } from "./paths.ts";
import type { AccountBinShares, FactoryBalances, FactoryEntry } from "./types.ts";

type PoolEvents = { kind: "v1"; modified: AbiEvent } | { kind: "v2plus"; added: AbiEvent; removed: AbiEvent };

function findEvent(abi: AbiEvent[], name: string): AbiEvent {
  const event = abi.find((e) => e.type === "event" && e.name === name);
  if (!event) throw new Error(`No ${name} event in pool ABI`);
  return event;
}

type WorkItem = { factory: Address; chainId: number; pool: Address; abiVersion: number; fromBlock: bigint };

export async function scanLiquidityEventsPhase(
  balances: FactoryBalances[],
  getClient: (chainId: number) => PublicClient | null,
): Promise<AccountBinShares[]> {
  const factories = await readJsonc<FactoryEntry[]>(FACTORIES_JSONC_PATH);
  const factoryByKey = new Map<string, FactoryEntry>();
  for (const entry of factories) factoryByKey.set(entry.factory.toLowerCase(), entry);

  const defaultFromBlock = BigInt(process.env.DEFAULT_FROM_BLOCK ?? "0");
  const CONCURRENCY = Number(process.env.CONCURRENCY ?? "8");

  const eventsCache = new Map<number, PoolEvents>();
  async function loadPoolEvents(version: number): Promise<PoolEvents> {
    const cached = eventsCache.get(version);
    if (cached) return cached;
    const abi = JSON.parse(await readFile(poolAbiPath(version), "utf8")) as AbiEvent[];
    const events: PoolEvents =
      version === 1
        ? { kind: "v1", modified: findEvent(abi, "LiquidityModified") }
        : { kind: "v2plus", added: findEvent(abi, "LiquidityAdded"), removed: findEvent(abi, "LiquidityRemoved") };
    eventsCache.set(version, events);
    return events;
  }

  const workItems: WorkItem[] = [];
  for (const factoryBalances of balances) {
    const entry = factoryByKey.get(factoryBalances.factory.toLowerCase());
    if (!entry) {
      console.warn(`skip ${factoryBalances.factory}: not found in factories.jsonc`);
      continue;
    }
    for (const chain of factoryBalances.chains) {
      const chainIdx = entry.chainIds.indexOf(chain.chainId);
      const knownBlock: number | null | undefined = entry.deploymentBlocks?.[chainIdx];
      const fromBlock = knownBlock != null ? BigInt(knownBlock) : defaultFromBlock;
      for (const pool of chain.pools) {
        workItems.push({ factory: factoryBalances.factory, chainId: chain.chainId, pool: pool.pool, abiVersion: entry.abiVersion, fromBlock });
      }
    }
  }

  // Net across every LiquidityAdded/Removed/Modified event touching the same (pool, chain,
  // account, salt, bin) — that quintuple is one on-chain position, so this is its current balance.
  const netShares = new Map<string, bigint>();
  function accumulate(chainId: number, pool: Address, account: Address, salt: bigint, bin: number, delta: bigint): void {
    const key = `${chainId}:${pool.toLowerCase()}:${account.toLowerCase()}:${salt}:${bin}`;
    netShares.set(key, (netShares.get(key) ?? 0n) + delta);
  }

  let scannedCount = 0;
  let skippedCount = 0;
  let incompleteCount = 0;

  async function processItem(item: WorkItem): Promise<void> {
    const client = getClient(item.chainId);
    if (!client) {
      console.warn(`skip ${item.pool} on chain ${item.chainId}: ${skipReason(item.chainId)}`);
      skippedCount++;
      return;
    }

    const events = await loadPoolEvents(item.abiVersion);
    const toBlock = await client.getBlockNumber();

    if (events.kind === "v1") {
      const { logs, incomplete } = await getLogsAdaptive(client, {
        address: item.pool,
        event: events.modified,
        fromBlock: item.fromBlock,
        toBlock,
      });
      for (const log of logs) {
        const a = (log as { args?: Record<string, unknown> }).args as {
          provider: Address;
          salt: bigint;
          bins: readonly number[];
          deltaShares: readonly bigint[];
        };
        for (let i = 0; i < a.bins.length; i++) {
          accumulate(item.chainId, item.pool, a.provider, a.salt, a.bins[i]!, a.deltaShares[i]!);
        }
      }
      if (incomplete.length) incompleteCount += incomplete.length;
    } else {
      const [addedResult, removedResult] = await Promise.all([
        getLogsAdaptive(client, { address: item.pool, event: events.added, fromBlock: item.fromBlock, toBlock }),
        getLogsAdaptive(client, { address: item.pool, event: events.removed, fromBlock: item.fromBlock, toBlock }),
      ]);
      for (const log of addedResult.logs) {
        const a = (log as { args?: Record<string, unknown> }).args as {
          provider: Address;
          salt: bigint;
          binIdxs: readonly bigint[];
          shares: readonly bigint[];
        };
        for (let i = 0; i < a.binIdxs.length; i++) {
          accumulate(item.chainId, item.pool, a.provider, a.salt, Number(a.binIdxs[i]), a.shares[i]!);
        }
      }
      for (const log of removedResult.logs) {
        const a = (log as { args?: Record<string, unknown> }).args as {
          provider: Address;
          salt: bigint;
          binIdxs: readonly bigint[];
          shares: readonly bigint[];
        };
        for (let i = 0; i < a.binIdxs.length; i++) {
          accumulate(item.chainId, item.pool, a.provider, a.salt, Number(a.binIdxs[i]), -a.shares[i]!);
        }
      }
      incompleteCount += addedResult.incomplete.length + removedResult.incomplete.length;
    }

    scannedCount++;
  }

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < workItems.length) {
      const item = workItems[nextIndex++]!;
      await processItem(item);
    }
  }
  console.log(`(a) scanning liquidity events for ${workItems.length} pool(s)...`);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, workItems.length) }, () => worker()));

  const factoryByPool = new Map<string, Address>();
  for (const item of workItems) factoryByPool.set(`${item.chainId}:${item.pool.toLowerCase()}`, item.factory);

  const result: AccountBinShares[] = [];
  for (const [key, shares] of netShares) {
    if (shares <= 0n) continue; // no longer a holder
    const [chainIdStr, pool, account, salt, binStr] = key.split(":");
    result.push({
      factory: factoryByPool.get(`${chainIdStr}:${pool}`)!,
      chainId: Number(chainIdStr),
      pool: pool as Address,
      account: account as Address,
      salt: salt!,
      bin: Number(binStr),
      shares: shares.toString(),
    });
  }

  console.log(`(a) Scanned ${scannedCount} pool(s), found ${result.length} active position(s).`);
  if (skippedCount) console.log(`Skipped ${skippedCount} pool(s).`);
  if (incompleteCount) console.warn(`WARNING: ${incompleteCount} incomplete block range(s) across all pools.`);

  return result;
}
