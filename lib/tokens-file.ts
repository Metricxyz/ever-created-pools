// Read/write for tokens.jsonc — written by step 2 phase (c) (metadata) and step 3 (priceUsd),
// read back by step 3 and step 4. Kept separate from the fetchers so fetching (get) and
// persisting (write) responsibilities live in distinct functions.
import { readFile, writeFile } from "node:fs/promises";
import stripJsonComments from "strip-json-comments";
import { TOKENS_JSONC_PATH } from "./paths.ts";
import type { ChainTokens } from "./types.ts";

// Returns [] if tokens.jsonc doesn't exist yet (first run) rather than throwing — callers that
// merge fresh data onto this (see mergeTokenMetadata below) need a base even before any file exists.
export async function readTokensFile(): Promise<ChainTokens[]> {
  let raw: string;
  try {
    raw = await readFile(TOKENS_JSONC_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return JSON.parse(stripJsonComments(raw));
}

// Reconciles freshly on-chain-fetched metadata (phase (c) of step 2 — name/symbol/decimals, no
// priceUsd) with whatever's already on disk, so re-running step 2 never wipes out priceUsd —
// including a price someone entered by hand for a token neither DeFiLlama nor CoinGecko can price.
// name/symbol/decimals always take the fresh (just-verified on-chain) value; priceUsd is carried
// over from `existing` whenever present there, fresh metadata never sets it at all.
export function mergeTokenMetadata(existing: ChainTokens[], fresh: ChainTokens[]): ChainTokens[] {
  const priceByKey = new Map<string, number | null | undefined>();
  for (const chain of existing) {
    for (const token of chain.tokens) {
      priceByKey.set(`${chain.chainId}:${token.address.toLowerCase()}`, token.priceUsd);
    }
  }

  return fresh.map((chain) => ({
    chainId: chain.chainId,
    tokens: chain.tokens.map((token) => ({
      ...token,
      priceUsd: priceByKey.get(`${chain.chainId}:${token.address.toLowerCase()}`),
    })),
  }));
}

const HEADER =
  "// Token metadata (name, symbol, decimals) + an estimated USD price for every token0/token1 seen\n" +
  "// across every pool factory/chain in factories.jsonc. name/symbol/decimals are read on-chain by\n" +
  "// step 2 (scripts/2-pools-with-balances.ts); priceUsd is fetched by step 3\n" +
  "// (scripts/3-get-token-prices.ts) from DeFiLlama primarily, CoinGecko as fallback — an ESTIMATE\n" +
  "// for valuing pool liquidity, not meant to be precise. null means the field couldn't be resolved —\n" +
  "// fill in by hand if you have a better source (see step 3a in README.md).\n";

export async function writeTokensFile(chains: ChainTokens[]): Promise<void> {
  await writeFile(TOKENS_JSONC_PATH, HEADER + JSON.stringify(chains, null, 2) + "\n");
  console.log(`Wrote tokens.jsonc`);
}
