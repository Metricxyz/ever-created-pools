// Step 2, phase (a): scans every factory in factories.jsonc for PoolCreated logs and returns the
// discovered pools for the next phases to use. Purely a getter — does not write to disk.
import { isAddressEqual, type AbiEvent, type Address, type PublicClient } from "viem";
import { readFile } from "node:fs/promises";
import { withRpcSlot } from "./rpc.ts";
import { skipReason } from "./env.ts";
import { readJsonc } from "./jsonc.ts";
import { FACTORIES_JSONC_PATH, abiPath } from "./paths.ts";
import type { CliArgs } from "./cli.ts";
import type { DiscoveredPool, FactoryEntry, IncompleteRange } from "./types.ts";

// Named so getLogsAdaptive/fetchRange's return type isn't repeated inline three times below —
// otherwise not obvious at a glance that "logs" here is viem's full untyped Log[] (only decoded
// once scanPools maps over it further down), not something already shaped like a pool record.
type LogsResult = { logs: Awaited<ReturnType<PublicClient["getLogs"]>>; incomplete: IncompleteRange[] };

// ---------- divide-and-conquer getLogs ----------
// A single eth_getLogs call over an entire multi-hundred-million-block range, filtered by
// address+topic, is normal and fast on real infra (indexed by address/bloom filter, not a
// block-by-block scan) — verified directly against Alchemy: a full 0-to-latest query over
// ~500M Arbitrum blocks returned in ~0.35s. So the whole range is always tried as ONE call
// first; splitting only happens if that specific call actually errors (range/result-size
// limit, or a persistent timeout), and then only the half that's still failing gets split
// further — a clean run costs exactly one request per (factory, chain).
async function getLogsAdaptive(
  client: PublicClient,
  { address, event, fromBlock, toBlock }: { address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint },
): Promise<LogsResult> {
  const MIN_RANGE = 500n;
  const MAX_RETRIES = 2;
  // Caps recursive splitting at 2^MAX_SPLIT_DEPTH leaf ranges (1024 at depth 10). Needed
  // because some endpoints (seen on Avalanche via Alchemy) time out on eth_getLogs regardless
  // of range size — without a depth cap, "split on timeout" recurses without bound, each level
  // doubling in-flight requests, taking effectively forever instead of failing a bounded
  // number of leftover ranges and moving on.
  const MAX_SPLIT_DEPTH = 10;

  async function fetchRange(from: bigint, to: bigint, depth: number): Promise<LogsResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const logs = await withRpcSlot(() => client.getLogs({ address, event, fromBlock: from, toBlock: to }));
        return { logs, incomplete: [] };
      } catch (err) {
        // IMPORTANT: never touch err.message / String(err) here — viem's RpcRequestError embeds
        // the full request URL (including the Alchemy API key from the query string) in that
        // field. Only err.details / err.shortMessage (and their .cause equivalents) are safe:
        // they carry the node's actual error text without the URL.
        const e = err as { shortMessage?: string; details?: string; cause?: { shortMessage?: string; details?: string } };
        const reason = e?.details || e?.cause?.details || "";
        const shortMsg = e?.shortMessage || e?.cause?.shortMessage || "";
        const msg = reason || shortMsg || "Unknown RPC error"; // prefer the specific node-reported reason for display
        const looksLikeSizeError = /range|limit|too many|10,?000|block range|exceed|took too long|timed? ?out/i.test(
          `${reason} ${shortMsg}`,
        );

        if (looksLikeSizeError && to - from >= MIN_RANGE && depth < MAX_SPLIT_DEPTH) {
          const mid = from + (to - from) / 2n;
          console.warn(`  splitting ${from}-${to} (depth ${depth}) after size error: ${msg.slice(0, 120)}`);
          const [left, right] = await Promise.all([fetchRange(from, mid, depth + 1), fetchRange(mid + 1n, to, depth + 1)]);
          return { logs: left.logs.concat(right.logs), incomplete: left.incomplete.concat(right.incomplete) };
        }

        if (attempt >= MAX_RETRIES) {
          console.error(`  giving up on blocks ${from}-${to} after ${attempt + 1} attempts: ${msg.slice(0, 200)}`);
          return { logs: [], incomplete: [{ fromBlock: from.toString(), toBlock: to.toString(), error: msg }] };
        }

        const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(`  retry ${attempt + 1}/${MAX_RETRIES} in ${backoffMs}ms on ${from}-${to}: ${msg.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  // A "successful" (no thrown error) response reporting zero logs is not necessarily trustworthy
  // on less mature infra: confirmed live on Monad via Alchemy — one full-range call returned 0
  // logs with no error, a second independent call for the exact same range returned 8 (the
  // correct count, verified against a third manual call). A single false-zero here silently
  // erases real pools with no error/incomplete signal to catch it, so zero is only trusted after
  // ZERO_CONFIRMATIONS consecutive independent calls agree — any non-zero/incomplete result along
  // the way wins immediately.
  const ZERO_CONFIRMATIONS = 2;
  let result: LogsResult = await fetchRange(fromBlock, toBlock, 0);
  let zeroStreak = result.logs.length === 0 && result.incomplete.length === 0 ? 1 : 0;

  while (zeroStreak > 0 && zeroStreak < ZERO_CONFIRMATIONS) {
    const retry: LogsResult = await fetchRange(fromBlock, toBlock, 0);
    if (retry.logs.length > 0 || retry.incomplete.length > 0) {
      console.warn(
        `  zero-result response for ${address} did not reproduce on retry ${zeroStreak}/${ZERO_CONFIRMATIONS} ` +
          `(got ${retry.logs.length} logs, ${retry.incomplete.length} incomplete range(s) instead) — using the retry`,
      );
      result = retry;
      zeroStreak = 0;
      break;
    }
    zeroStreak++;
  }

  return result;
}

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
