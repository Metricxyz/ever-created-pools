// .env loading and RPC endpoint resolution, shared by every script that talks to a chain.
import { readFile } from "node:fs/promises";
import { ROOT } from "./paths.ts";

// ---------- tiny .env loader (no dependency) ----------
export async function loadDotEnv(): Promise<void> {
  try {
    const text = await readFile(ROOT + "/.env", "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no .env file — fine, rely on real env vars
  }
}

// Alchemy's JSON-RPC subdomain per network: https://<slug>.g.alchemy.com/v2/<key>.
// Verified live (eth_chainId round-trip against the actual key) for all 10 deployed chains.
export const ALCHEMY_NETWORK_SLUGS: Record<number, string> = {
  1: "eth-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
  43114: "avax-mainnet",
  137: "polygon-mainnet",
  56: "bnb-mainnet",
  4326: "megaeth-mainnet",
  999: "hyperliquid-mainnet",
  143: "monad-mainnet",
  4663: "robinhood-mainnet",
};

// ---------- RPC URL resolution (Alchemy only — see ALCHEMY_NETWORK_SLUGS above) ----------
export function resolveRpcUrl(chainId: number): string | null {
  const slug = ALCHEMY_NETWORK_SLUGS[chainId];
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (slug && alchemyKey) return `https://${slug}.g.alchemy.com/v2/${alchemyKey}`;
  return null;
}

export function skipReason(chainId: number): string {
  const hasSlug = Boolean(ALCHEMY_NETWORK_SLUGS[chainId]);
  return hasSlug
    ? `no ALCHEMY_API_KEY set`
    : `chain ${chainId} has no known Alchemy network — add it to ALCHEMY_NETWORK_SLUGS`;
}
