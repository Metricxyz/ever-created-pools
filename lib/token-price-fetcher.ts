// Step 3: adds a priceUsd field to every token in tokens.jsonc — an ESTIMATE for valuing pool
// liquidity in USD, not meant to be precise.
//
// Primary source: DeFiLlama's free /prices/current API (no key, no meaningful rate limit,
// batches many chain:address pairs into ONE request). Verified live to have far better coverage
// than CoinGecko for this dataset — it resolved 10/10 test tokens including obscure/low-liquidity
// ones in a single request, vs. CoinGecko needing one throttled request per token. Likely because
// DeFiLlama derives prices from actual on-chain DEX liquidity, not just curated exchange listings.
//
// Fallback: CoinGecko's /simple/token_price API, only for whatever DeFiLlama didn't resolve —
// anonymous tier allows one contract per request and rate-limits hard (429 after ~2 rapid calls,
// with a `retry-after` header), so this path is serialized and paced; only worth it because the
// fallback set should be small after DeFiLlama's pass. Set COINGECKO_API_KEY (a free Demo key) to
// raise that limit instead of hitting it — unset, requests go out unauthenticated as before.
//
// Anything neither source has is left as-is — step 3a (manual, see README) is for filling those in
// by hand; this module does not guess, and never overwrites an existing priceUsd (manual or
// previously fetched) with null just because this run couldn't resolve one. A price is only ever
// overwritten when a fresh one was actually found — so a manually-entered price for a token
// neither source can price is never lost to a rerun.
//
// Purely a getter — takes already-loaded token data in and returns updated data out (mutated in
// place, same references, so untouched out-of-scope chains pass through unchanged). Does not read
// or write tokens.jsonc itself; use lib/tokens-file.ts's readTokensFile()/writeTokensFile() for that.
import type { CliArgs } from "./cli.ts";
import type { ChainTokens } from "./types.ts";

// Verified live against https://coins.llama.fi/prices/current/<chain>:<address> — all 10 resolved
// in one batched call (not guessed).
const DEFILLAMA_CHAIN: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  56: "bsc",
  137: "polygon",
  4326: "megaeth",
  999: "hyperevm",
  143: "monad",
  4663: "robinhood",
};

// Fallback only — confirmed live against /api/v3/asset_platforms.
const COINGECKO_PLATFORM: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum-one",
  43114: "avalanche",
  56: "binance-smart-chain",
  137: "polygon-pos",
  4326: "megaeth",
  999: "hyperevm",
  143: "monad",
  4663: "robinhood",
};

// Optional CoinGecko Demo API key (https://www.coingecko.com/en/developers/dashboard) — raises
// the anonymous tier's very tight rate limit to ~30 calls/min. Unset: requests go out
// unauthenticated, same as before this existed.
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const COINGECKO_DELAY_MS = Number(process.env.COINGECKO_DELAY_MS ?? "3000");
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRIES = 3;
const DEFILLAMA_BATCH_SIZE = 100; // keep request URLs comfortably under length limits

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- DeFiLlama (primary, batched) ----------
async function fetchDefiLlamaBatch(
  keys: Array<{ chainId: number; address: string; defillamaChain: string }>,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>(); // key: `${chainId}:${address.toLowerCase()}`

  for (let i = 0; i < keys.length; i += DEFILLAMA_BATCH_SIZE) {
    const batch = keys.slice(i, i + DEFILLAMA_BATCH_SIZE);
    const query = batch.map((k) => `${k.defillamaChain}:${k.address}`).join(",");
    const url = `https://coins.llama.fi/prices/current/${query}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  DeFiLlama batch failed: HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { coins: Record<string, { price?: number }> };
      for (const k of batch) {
        const entry = data.coins[`${k.defillamaChain}:${k.address}`];
        if (entry?.price != null) {
          prices.set(`${k.chainId}:${k.address.toLowerCase()}`, entry.price);
        }
      }
    } catch (err) {
      console.warn(`  DeFiLlama batch request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return prices;
}

// ---------- CoinGecko (fallback, one contract per request, rate-limited) ----------
async function fetchCoinGeckoPrice(platform: string, address: string): Promise<number | null> {
  const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${address}&vs_currencies=usd`;

  const headers = COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterS = retryAfterHeader ? Number(retryAfterHeader) : DEFAULT_RETRY_AFTER_S;
      console.warn(`    429 rate limited, waiting ${retryAfterS}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
      await sleep(retryAfterS * 1000);
      continue;
    }
    if (!res.ok) {
      if (attempt >= MAX_RETRIES) return null;
      await sleep(Math.min(2000 * 2 ** attempt, 15000));
      continue;
    }

    const data = (await res.json()) as Record<string, { usd?: number }>;
    return data[address.toLowerCase()]?.usd ?? null;
  }

  return null;
}

export interface FetchPricesResult {
  totalTokens: number;
  totalPriced: number;
}

// Mutates priceUsd onto the tokens inside `chains` (same object references) and returns stats;
// the caller decides whether/how to persist the (now-mutated) `chains` it passed in.
export async function fetchTokenPrices(chains: ChainTokens[], args: Pick<CliArgs, "chains">): Promise<FetchPricesResult> {
  const relevantChains = chains.filter((c) => !args.chains || args.chains.includes(c.chainId));

  // ---- Pass 1: DeFiLlama, batched across every chain/token in scope ----
  const llamaKeys = relevantChains.flatMap((chain) => {
    const defillamaChain = DEFILLAMA_CHAIN[chain.chainId];
    if (!defillamaChain) return [];
    return chain.tokens.map((t) => ({ chainId: chain.chainId, address: t.address, defillamaChain }));
  });
  console.log(`DeFiLlama pass: ${llamaKeys.length} token(s) across ${new Set(llamaKeys.map((k) => k.chainId)).size} chain(s)...`);
  const llamaPrices = await fetchDefiLlamaBatch(llamaKeys);
  console.log(`  resolved ${llamaPrices.size}/${llamaKeys.length}`);

  for (const chain of relevantChains) {
    for (const token of chain.tokens) {
      const price = llamaPrices.get(`${chain.chainId}:${token.address.toLowerCase()}`);
      if (price != null) token.priceUsd = price; // only overwrite when a fresh price was found
    }
  }

  // ---- Pass 2: CoinGecko fallback, only for what DeFiLlama missed ----
  const missing = relevantChains.flatMap((chain) =>
    chain.tokens.filter((t) => t.priceUsd == null).map((t) => ({ chainId: chain.chainId, token: t })),
  );

  if (missing.length > 0) {
    console.log(`\nCoinGecko fallback pass: ${missing.length} token(s) DeFiLlama didn't resolve...`);
    let cgResolved = 0;
    for (const { chainId, token } of missing) {
      const platform = COINGECKO_PLATFORM[chainId];
      if (!platform) continue;
      const price = await fetchCoinGeckoPrice(platform, token.address);
      if (price != null) {
        token.priceUsd = price;
        cgResolved++;
        console.log(`  ${token.symbol ?? token.address} (chain ${chainId}): $${price}`);
      } else {
        console.log(`  ${token.symbol ?? token.address} (chain ${chainId}): not found either — left null`);
      }
      await sleep(COINGECKO_DELAY_MS);
    }
    console.log(`  resolved ${cgResolved}/${missing.length} via CoinGecko fallback`);
  }

  const totalTokens = relevantChains.reduce((sum, c) => sum + c.tokens.length, 0);
  const totalPriced = relevantChains.reduce((sum, c) => sum + c.tokens.filter((t) => t.priceUsd != null).length, 0);

  return { totalTokens, totalPriced };
}
