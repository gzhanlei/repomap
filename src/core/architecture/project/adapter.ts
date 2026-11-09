import { z } from "zod";
import { declarationRecordSchema, irOmissionSchema, type DeclarationRecord } from "../ir.js";
import { architectureViewSchema, capabilitySchema } from "../scope.js";
import type { SourceSnapshot } from "./snapshot.js";

/**
 * M2 / project-preparation: LanguageAdapter is a *project-level* contract, not
 * a per-file callback. prepareProject consumes the immutable raw snapshot and
 * produces project units; parseProject and the discovery methods consume those
 * units. Declaration discovery stays a separate classification path from
 * semantic extraction, even though the interface is shared.
 */

export const adapterStatusSchema = z.enum(["available", "partial", "unavailable"]);
export type AdapterStatus = z.infer<typeof adapterStatusSchema>;

export const adapterCapabilitySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  status: adapterStatusSchema,
  detail: z.string().min(1).optional(),
}).strict();
export type AdapterCapability = z.infer<typeof adapterCapabilitySchema>;

/** Build context is explicit: no implicit GOOS/GOARCH/tags from the host. */
export const buildContextSchema = z.object({
  goos: z.string().min(1),
  goarch: z.string().min(1),
  buildTags: z.array(z.string()),
  workspaces: z.array(z.string()),
  replaces: z.array(z.string()),
}).strict();
export type BuildContext = z.infer<typeof buildContextSchema>;

export const projectUnitStatusSchema = z.enum(["prepared", "parser-unavailable", "no-adapter"]);
export const projectUnitSchema = z.object({
  id: z.string().min(1),
  language: z.string().min(1),
  packageId: z.string().min(1),
  root: z.string(),
  adapterId: z.string().min(1),
  files: z.array(z.string().min(1)),
  manifests: z.array(z.string().min(1)),
  status: projectUnitStatusSchema,
}).strict();
export type ProjectUnit = z.infer<typeof projectUnitSchema>;

export const importRefSchema = z.object({
  path: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(["static", "dynamic", "re-export", "require"]),
  line: z.number().int().positive(),
  resolvedPath: z.string().min(1).optional(),
  unresolvedReason: z.string().min(1).optional(),
}).strict();
export type ImportRef = z.infer<typeof importRefSchema>;

export const symbolSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  exported: z.boolean(),
  line: z.number().int().positive(),
}).strict();
export type SymbolRecord = z.infer<typeof symbolSchema>;

export const entrypointSchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
  line: z.number().int().positive(),
}).strict();
export type EntrypointCandidate = z.infer<typeof entrypointSchema>;

export const parseErrorSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  message: z.string().min(1),
}).strict();
export type ProjectParseError = z.infer<typeof parseErrorSchema>;

export const parseProjectResultSchema = z.object({
  unitId: z.string().min(1),
  imports: z.array(importRefSchema),
  symbols: z.array(symbolSchema),
  entrypoints: z.array(entrypointSchema),
  parseErrors: z.array(parseErrorSchema),
  notes: z.array(z.string()),
}).strict();
export type ParseProjectResult = z.infer<typeof parseProjectResultSchema>;

export const projectPreparationSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  snapshotId: z.string().min(1),
  buildContext: buildContextSchema,
  distribution: z.object({
    engine: z.literal("node"),
    node: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    parserVersions: z.record(z.string(), z.string()),
  }).strict(),
  units: z.array(projectUnitSchema),
  imports: z.array(importRefSchema),
  symbols: z.array(symbolSchema),
  entrypoints: z.array(entrypointSchema),
  parseErrors: z.array(parseErrorSchema),
  declarations: z.array(declarationRecordSchema),
  unresolvedImports: z.array(importRefSchema),
  parsers: z.array(capabilitySchema),
  capabilities: z.array(adapterCapabilitySchema),
  omissions: z.array(irOmissionSchema),
  gates: z.object({
    blockedViews: z.array(architectureViewSchema),
    runtimeOverviewUnaffected: z.boolean(),
    reasons: z.array(z.string()),
  }).strict(),
  statistics: z.object({
    units: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    imports: z.number().int().nonnegative(),
    unresolvedImports: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    entrypoints: z.number().int().nonnegative(),
    parseErrors: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type ProjectPreparation = z.infer<typeof projectPreparationSchema>;

export interface LanguageAdapter {
  id: string;
  version: string;
  languages: readonly string[];
  prepareProject(snapshot: SourceSnapshot, context: BuildContext): ProjectUnit[];
  parseProject(project: ProjectUnit): ParseProjectResult;
  declarations(project: ProjectUnit): DeclarationRecord[];
  symbols(project: ProjectUnit): SymbolRecord[];
  imports(project: ProjectUnit): ImportRef[];
  entrypoints(project: ProjectUnit): EntrypointCandidate[];
  capabilities(): AdapterCapability[];
}

export function emptyParseResult(unitId: string, notes: string[] = []): ParseProjectResult {
  return parseProjectResultSchema.parse({ unitId, imports: [], symbols: [], entrypoints: [], parseErrors: [], notes });
}

export function packageRoot(packageId: string) {
  return packageId === "package:root" ? "." : packageId.replace(/^package:/, "");
}

/** One adapter owns one language group; an absent or unavailable parser is a declared state, never an exception. */
export function adapterStatus(adapter: LanguageAdapter): AdapterStatus {
  const statuses = adapter.capabilities().map((capability) => capability.status);
  if (statuses.length === 0 || statuses.every((status) => status === "unavailable")) return "unavailable";
  if (statuses.every((status) => status === "available")) return "available";
  return "partial";
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>();

  constructor(adapters: Iterable<LanguageAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: LanguageAdapter) {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate language adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  forLanguage(language: string) {
    return [...this.adapters.values()].find((adapter) => adapter.languages.includes(language));
  }

  list() {
    return [...this.adapters.values()];
  }
}

/**
 * A declared-but-unshipped adapter. Used for Go until its package-aware helper
 * lands, and by tests that need to prove parser-unavailable gating. It produces
 * units with an explicit status instead of silently dropping files.
 */
export function createUnavailableAdapter(id: string, languages: string[], reason: string): LanguageAdapter {
  return {
    id,
    version: "0",
    languages,
    prepareProject(snapshot) {
      const groups = new Map<string, string[]>();
      for (const file of snapshot.files) {
        if (file.role !== "source" || !languages.includes(file.language)) continue;
        const paths = groups.get(file.packageId) ?? [];
        paths.push(file.path);
        groups.set(file.packageId, paths);
      }
      return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([packageId, paths]) => projectUnitSchema.parse({
        id: `unit:${packageId}:${languages.join("+")}:unavailable`,
        language: languages.join("+"),
        packageId,
        root: packageRoot(packageId),
        adapterId: id,
        files: paths.sort(),
        manifests: [],
        status: "parser-unavailable",
      }));
    },
    parseProject(project) { return emptyParseResult(project.id, [reason]); },
    declarations() { return []; },
    symbols() { return []; },
    imports() { return []; },
    entrypoints() { return []; },
    capabilities() { return [{ id, version: "0", status: "unavailable", detail: reason }]; },
  };
}
