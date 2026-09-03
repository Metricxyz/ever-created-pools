// Tiny wrapper for reading JSONC (JSON with // and /* */ comments) files — factories.jsonc and
// tokens.jsonc both use this format so they can carry inline annotations.
import { readFile } from "node:fs/promises";
import stripJsonComments from "strip-json-comments";

export async function readJsonc<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(stripJsonComments(raw)) as T;
}
