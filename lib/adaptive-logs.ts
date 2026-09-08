// Shared adaptive eth_getLogs — used by lib/pool-scanner.ts (factory PoolCreated logs) and
// lib/liquidity-events.ts (per-pool LiquidityAdded/Removed/Modified logs).
import type { AbiEvent, Address, PublicClient } from "viem";
import { withRpcSlot } from "./rpc.ts";
import type { IncompleteRange } from "./types.ts";

export type LogsResult = { logs: Awaited<ReturnType<PublicClient["getLogs"]>>; incomplete: IncompleteRange[] };

// ---------- divide-and-conquer getLogs ----------
// A single eth_getLogs call over an entire multi-hundred-million-block range, filtered by
// address+topic, is normal and fast on real infra (indexed by address/bloom filter, not a
// block-by-block scan) — verified directly against Alchemy: a full 0-to-latest query over
// ~500M Arbitrum blocks returned in ~0.35s. So the whole range is always tried as ONE call
// first; splitting only happens if that specific call actually errors (range/result-size
// limit, or a persistent timeout), and then only the half that's still failing gets split
// further — a clean run costs exactly one request per (factory, chain).
export async function getLogsAdaptive(
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
