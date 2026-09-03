// RPC client creation + a shared concurrency limiter for actual RPC calls.
import { createPublicClient, http, type PublicClient } from "viem";
import { resolveRpcUrl } from "./env.ts";

// Global concurrency limit for actual RPC calls, shared across every phase and every recursive
// split within a log scan. Without this, a chain whose endpoint times out even on small ranges
// (seen on Avalanche — timeouts persisted down to ~1500-block windows) causes unbounded recursive
// fan-out: each failing call splits into two more, each of those splits again, etc., with no cap
// on concurrent in-flight requests — a thundering herd that makes the underlying rate limiting
// worse and the whole run take forever instead of failing a few ranges cleanly. Every RPC call
// that goes through this module's clients should be wrapped in withRpcSlot().
const RPC_CONCURRENCY = Number(process.env.RPC_CONCURRENCY ?? "8");
let activeRpcCalls = 0;
const rpcQueue: Array<() => void> = [];
export async function withRpcSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRpcCalls >= RPC_CONCURRENCY) {
    await new Promise<void>((resolve) => rpcQueue.push(resolve));
  }
  activeRpcCalls++;
  try {
    return await fn();
  } finally {
    activeRpcCalls--;
    rpcQueue.shift()?.();
  }
}

// A fresh client-cache-backed resolver per call site (each script gets its own cache, so
// concurrent/independent runs — e.g. tests — don't share state through a module-level singleton).
export function createClientResolver(): (chainId: number) => PublicClient | null {
  const clientCache = new Map<number, PublicClient | null>();
  return function getClient(chainId: number): PublicClient | null {
    if (clientCache.has(chainId)) return clientCache.get(chainId)!;
    const rpcUrl = resolveRpcUrl(chainId);
    if (!rpcUrl) {
      clientCache.set(chainId, null);
      return null;
    }
    // Connection: close forces a fresh connection per request rather than reusing one pooled
    // connection for the client's lifetime. Necessary for correctness, not just speed: verified
    // live on Monad via Alchemy that a pooled connection can get pinned to a stale/bad backend
    // replica that consistently returns empty eth_getLogs results with no error — while separate
    // (non-pooled) requests to the same endpoint at the same time consistently returned the
    // correct non-empty result.
    const client = createPublicClient({
      transport: http(rpcUrl, { fetchOptions: { headers: { Connection: "close" } } }),
    }) as PublicClient;
    clientCache.set(chainId, client);
    return client;
  };
}
