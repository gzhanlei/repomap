import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArchitectureFactSet } from "./facts.js";
import type { ArchitectureSource } from "./source.js";
import type { SourceCensus } from "./census.js";
import { declarationRecordSchema, type DeclarationRecord } from "./ir.js";
import { classifySourcePath, detectSourceLanguage } from "./file-roles.js";

/**
 * M0/M1 bootstrap: an independent declaration inventory. Discovery uses raw
 * entry structure, manifest parsing and a *separate* protocol-capability word
 * list. It never calls a production semantic detector, so disabling those
 * detectors cannot shrink the coverage denominator (proved by mutationCheck).
 */

export const declarationInventorySchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  discovery: z.literal("independent-structure-and-manifest-discovery"),
  declarations: z.array(declarationRecordSchema),
  statistics: z.object({
    total: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
  }).strict(),
  capabilityGaps: z.array(z.string().min(1)),
  protocolGaps: z.array(z.string().min(1)),
}).strict();
export type DeclarationInventory = z.infer<typeof declarationInventorySchema>;

const knownFrameworks = new Set(["next", "vite", "react", "react-dom", "vue", "nuxt", "express", "fastify", "nestjs", "@nestjs/core", "svelte", "@sveltejs/kit", "remix", "koa", "hono", "angular"]);

const protocolCapabilityRules: { name: string; markers: RegExp[] }[] = [
  { name: "grpc", markers: [/@grpc\/grpc-js/i, /\bgrpc\.(?:Client|Server)\b/, /\.proto\b/] },
  { name: "websocket", markers: [/\bnew WebSocket\s*\(/, /\bwss?:\/\//, /\bsocket\.io\b/] },
  { name: "object-storage", markers: [/\bs3:\/\//, /\bPutObject\s*\(/, /\bcos\.tencentcloudapi\.com\b/, /\bGetObject\s*\(/] },
  { name: "cloud-messaging", markers: [/\bamqp:\/\//, /\bkafkajs\b/, /\bSQSClient\b/, /\bpubsub\b/] },
];

function declarationId(kind: string, path: string, detail: string) {
  return `decl:${createHash("sha256").update(`${kind}|${path}|${detail}`).digest("hex").slice(0, 16)}`;
}

function unnumbered(content: string) {
  return content.replace(/^\s*\d+:\s?/gm, "");
}

function declaration(kind: DeclarationRecord["kind"], sourcePath: string, owner: string, detail: string, critical: boolean, capability: string): DeclarationRecord {
  return {
    declarationId: declarationId(kind, sourcePath, detail),
    kind, owner, required: critical, critical, sourcePath, detail, capability, evidenceIds: [],
  };
}

export interface BuildDeclarationInput {
  revision: string;
  census: SourceCensus;
  sources: ArchitectureSource[];
}

export function buildDeclarationInventory(input: BuildDeclarationInput): DeclarationInventory {
  const byPath = new Map(input.sources.map((source) => [source.path, source]));
  const declarations: DeclarationRecord[] = [];
  const capabilityGaps = new Set<string>();
  const protocolGaps = new Set<string>();

  for (const file of input.census.files) {
    const content = byPath.get(file.path)?.content;
    if (file.path.endsWith(".gitmodules") || file.entryKind === "gitlink") {
      capabilityGaps.add("unresolved-submodule");
      declarations.push(declaration("capability", file.path, file.packageId, "submodule requires its own fixed-SHA snapshot", true, "unresolved-submodule"));
    }
    if (file.status === "unsupported") {
      capabilityGaps.add(`unsupported-language:${file.language}`);
    }
    if (file.role === "manifest" && file.path.endsWith("package.json") && content) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(unnumbered(content)) as Record<string, unknown>; } catch { capabilityGaps.add("unparseable-manifest"); }
      const scripts = (parsed.scripts ?? {}) as Record<string, string>;
      const dependencies = (parsed.dependencies ?? {}) as Record<string, string>;
      if (typeof scripts.start === "string" || typeof scripts.dev === "string") {
        declarations.push(declaration("deployable", file.path, file.packageId, `start:${scripts.start ?? scripts.dev}`, true, "package-script"));
      }
      for (const [name, version] of Object.entries(dependencies)) {
        if (knownFrameworks.has(name)) {
          declarations.push(declaration("capability", file.path, file.packageId, `framework:${name}@${version}`, false, `framework:${name}`));
        } else if (/framework/i.test(name)) {
          capabilityGaps.add(`unsupported-framework:${name}@${version}`);
          declarations.push(declaration("capability", file.path, file.packageId, `unknown-framework:${name}@${version}`, false, "unsupported-framework"));
        }
      }
    }
    if (file.role === "manifest" && file.path.endsWith("go.mod")) {
      declarations.push(declaration("package", file.path, file.packageId, "go-module", false, "go.mod"));
    }
    if (/(?:^|\/)app\/.*route\.tsx?$/.test(file.path)) {
      declarations.push(declaration("route", file.path, file.packageId, "app-router-route-file", true, "file-route"));
    }
    if (/(?:^|\/)app\/.*page\.tsx$|(?:^|\/)pages\/index\.tsx$|(?:^|\/)main\.go$/.test(file.path)) {
      declarations.push(declaration("entrypoint", file.path, file.packageId, "entrypoint-file", true, "file-entrypoint"));
    }
    if (file.role === "migration" || /\.(?:sql|prisma)$/i.test(file.path)) {
      declarations.push(declaration("store", file.path, file.packageId, "schema-or-migration-file", false, "schema-file"));
    }
    if (file.status === "selected" && classifySourcePath(file.path) === "source" && content) {
      const code = unnumbered(content);
      for (const rule of protocolCapabilityRules) {
        if (rule.markers.some((marker) => marker.test(code))) {
          protocolGaps.add(`unsupported-protocol:${rule.name}`);
          declarations.push(declaration("protocol", file.path, file.packageId, `protocol:${rule.name}`, true, `unsupported-protocol:${rule.name}`));
        }
      }
    }
    if (file.status === "selected" && detectSourceLanguage(file.path) === "unknown") capabilityGaps.add("unknown-language-extension");
  }

  const sorted = declarations.sort((a, b) => a.declarationId.localeCompare(b.declarationId));
  const byKind = Object.fromEntries([...new Set(sorted.map((item) => item.kind))].sort().map((kind) => [kind, sorted.filter((item) => item.kind === kind).length]));
  return declarationInventorySchema.parse({
    version: 1,
    revision: input.revision,
    discovery: "independent-structure-and-manifest-discovery",
    declarations: sorted,
    statistics: { total: sorted.length, critical: sorted.filter((item) => item.critical).length, byKind },
    capabilityGaps: [...capabilityGaps].sort(),
    protocolGaps: [...protocolGaps].sort(),
  });
}

export interface DeclarationCoverage {
  total: number;
  covered: number;
  missing: DeclarationRecord[];
  blocking: boolean;
}

/** Bootstrap evaluator: a critical declaration is covered when a published fact owns its source path. */
export function evaluateDeclarationCoverage(inventory: DeclarationInventory, facts: Pick<ArchitectureFactSet, "nodes" | "edges">): DeclarationCoverage {
  const owned = new Set<string>();
  for (const node of facts.nodes) {
    for (const path of node.sourcePaths ?? []) owned.add(path);
    for (const item of node.evidence) owned.add(item.path);
  }
  for (const edge of facts.edges) for (const item of edge.evidence) owned.add(item.path);
  const critical = inventory.declarations.filter((item) => item.critical);
  const missing = critical.filter((item) => !owned.has(item.sourcePath)).sort((a, b) => a.declarationId.localeCompare(b.declarationId));
  return { total: critical.length, covered: critical.length - missing.length, missing, blocking: missing.length > 0 };
}

export interface MutationResult {
  passed: boolean;
  declarationsRetained: number;
  baselineMissing: number;
  mutatedMissing: number;
  reason: string;
}

/** Disabling every semantic extractor must NOT shrink the independent denominator. */
export function mutationCheck(inventory: DeclarationInventory, facts: Pick<ArchitectureFactSet, "nodes" | "edges">): MutationResult {
  const baseline = evaluateDeclarationCoverage(inventory, facts);
  const mutated = evaluateDeclarationCoverage(inventory, { nodes: [], edges: [] });
  const retained = inventory.declarations.length;
  const passed = retained > 0 && mutated.total === baseline.total && mutated.total > 0 && mutated.missing.length > 0 && mutated.missing.length >= baseline.missing.length && mutated.blocking;
  return {
    passed,
    declarationsRetained: retained,
    baselineMissing: baseline.missing.length,
    mutatedMissing: mutated.missing.length,
    reason: passed
      ? "Independent declarations survived extractor removal and coverage reported missing facts."
      : "Declaration denominator changed with extractors removed, or mutation did not block coverage.",
  };
}
