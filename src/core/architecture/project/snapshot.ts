import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceCensus } from "../census.js";
import type { ArchitectureSource } from "../source.js";

/**
 * M2 / project-preparation: the parser input is immutable raw text, never the
 * numbered display view. The numbered view is only an evidence projection, so
 * AST offsets, content hashes and cache keys can never depend on display
 * formatting. The snapshot ID is content-addressed over the raw entry set and
 * is shared by the census, adapters, helpers and caches.
 */

export const sourceSnapshotFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  language: z.string().min(1),
  role: z.string().min(1),
  packageId: z.string().min(1),
}).strict();
export type SourceSnapshotFile = z.infer<typeof sourceSnapshotFileSchema>;

export interface SourceSnapshot {
  readonly snapshotId: string;
  readonly revision: string;
  readonly files: readonly SourceSnapshotFile[];
  rawText(path: string): string | undefined;
  numberedText(path: string): string | undefined;
  lineForOffset(path: string, offset: number): number | undefined;
}

/** Lossy fallback for synthetic sources that do not carry raw text. */
export function unnumberedText(numbered: string) {
  return numbered.split("\n").map((line) => line.replace(/^\d+: ?/, "")).join("\n");
}

export function numberedText(raw: string) {
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${index + 1}: ${line}`).join("\n");
}

/** AST character offsets map back to 1-based evidence line numbers. */
export function lineForRawOffset(raw: string, offset: number) {
  if (!Number.isFinite(offset) || offset < 0) return undefined;
  const clamped = Math.min(Math.floor(offset), raw.length);
  let line = 1;
  for (let index = 0; index < clamped; index += 1) if (raw[index] === "\n") line += 1;
  return line;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export interface CreateSourceSnapshotInput {
  revision: string;
  sources: ArchitectureSource[];
  census: SourceCensus;
}

export function createSourceSnapshot(input: CreateSourceSnapshotInput): SourceSnapshot {
  const byPath = new Map(input.sources.map((source) => [source.path, source]));
  const rawFor = (path: string) => {
    const source = byPath.get(path);
    if (source === undefined) return undefined;
    return source.rawText?.() ?? unnumberedText(source.content);
  };
  const numberedFor = (path: string) => {
    const source = byPath.get(path);
    if (source === undefined) return undefined;
    return source.rawText ? source.content : numberedText(unnumberedText(source.content));
  };
  const files: SourceSnapshotFile[] = input.census.files
    .filter((entry) => entry.entryKind === "file" && byPath.has(entry.path) && (entry.status === "selected" || entry.role === "manifest" || entry.role === "config"))
    .map((entry) => sourceSnapshotFileSchema.parse({
      path: entry.path,
      size: entry.size,
      sha256: sha256(rawFor(entry.path) ?? ""),
      language: entry.language,
      role: entry.role,
      packageId: entry.packageId,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const snapshotId = sha256(`${input.revision}\n${files.map((file) => `${file.path}:${file.size}:${file.sha256}`).join("\n")}`);
  return Object.freeze({
    snapshotId,
    revision: input.revision,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    rawText: rawFor,
    numberedText: numberedFor,
    lineForOffset(path: string, offset: number) {
      const raw = rawFor(path);
      return raw === undefined ? undefined : lineForRawOffset(raw, offset);
    },
  });
}
