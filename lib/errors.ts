// Safe error-message extraction for top-level `main().catch(...)` handlers.
//
// IMPORTANT: never surface err.message / String(err) from a viem RPC error — viem's
// RpcRequestError embeds the full request URL (including the Alchemy API key from the query
// string) in that field. Only err.details / err.shortMessage (and their .cause equivalents) are
// safe: they carry the node's actual error text without the URL.
export function safeErrorMessage(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; cause?: { shortMessage?: string; details?: string } };
  return e?.details || e?.cause?.details || e?.shortMessage || e?.cause?.shortMessage || "Unknown error";
}
