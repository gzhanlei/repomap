import { z } from "zod";
import type { ArchitectureFactSet } from "./facts.js";
import { evidenceIdsFor, type EvidenceIndex } from "./evidence-index.js";
import { capabilitySchema, declaredScopeSchema, repomapCapabilities, type DeclaredScope } from "./scope.js";
import type { SourceCensus } from "./census.js";
import type { DeclarationInventory } from "./declarations.js";

/**
 * M0 defines the versioned IR/evidence/declaration envelope (schema only).
 * M1 dual-writes it from the same facts v1 projection. facts v1 is deliberately
 * left untouched: the lossless reconciliation set is IR + Evidence Index +
 * Projection Manifest, never facts v1 or the HTML document.
 */

export const declarationRecordSchema = z.object({
  declarationId: z.string().min(1),
  kind: z.enum(["entrypoint", "deployable", "route", "store", "external", "worker", "package", "protocol", "operation", "capability"]),
  owner: z.string().min(1),
  required: z.boolean(),
  critical: z.boolean(),
  sourcePath: z.string().min(1),
  detail: z.string().min(1),
  capability: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type DeclarationRecord = z.infer<typeof declarationRecordSchema>;

export const omissionReasonSchema = z.enum([
  "unsupported-language", "unsupported-framework", "unsupported-protocol", "unsupported-syntax", "parser-unavailable",
  "parse-error", "unresolved-import", "unresolved-handler", "unresolved-submodule", "unknown-identity", "uncertain-direction",
  "generated", "test-only", "out-of-scope", "duplicate", "budget-exceeded",
]);
export const irOmissionSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  reason: omissionReasonSchema,
  detail: z.string().min(1),
  declarationIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  affectedViews: z.array(z.string().min(1)),
  blocking: z.boolean(),
}).strict();
export type IrOmission = z.infer<typeof irOmissionSchema>;

const resolutionSchema = z.enum(["static", "configured", "dynamic", "unknown"]);
const targetKindSchema = z.enum(["host", "service", "protocol", "queue", "database", "unknown"]);

export const irNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  owner: z.string().min(1),
  scope: z.string().min(1),
  resolution: resolutionSchema,
  synthetic: z.boolean(),
  sourcePaths: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  declarationIds: z.array(z.string().min(1)),
}).strict();

export const irEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  direction: z.enum(["outbound", "inbound", "uncertain"]),
  resolution: resolutionSchema,
  evidenceIds: z.array(z.string().min(1)),
  declarationIds: z.array(z.string().min(1)),
}).strict();

const operationBase = {
  id: z.string().min(1),
  owner: z.string().min(1),
  declarationIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  targetKind: targetKindSchema,
  resolution: resolutionSchema,
};
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), method: z.string(), path: z.string(), callSite: z.string(), ...operationBase }).strict(),
  z.object({ kind: z.literal("graphql"), operationName: z.string(), operationType: z.string(), documentHash: z.string(), callSite: z.string(), ...operationBase }).strict(),
  z.object({ kind: z.literal("queue"), action: z.string(), topic: z.string(), ...operationBase }).strict(),
  z.object({ kind: z.literal("sql"), action: z.string(), driver: z.string(), callSite: z.string(), ...operationBase }).strict(),
  z.object({ kind: z.literal("schedule"), schedule: z.string(), jobOwner: z.string(), ...operationBase }).strict(),
  z.object({ kind: z.literal("config-binding"), configKey: z.string(), defaultValue: z.string(), override: z.string(), usedAt: z.string(), ...operationBase }).strict(),
]);
export type OperationFact = z.infer<typeof operationSchema>;

export const architectureIrSchema = z.object({
  version: z.literal(2),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  view: z.string().min(1),
  declaredScope: declaredScopeSchema,
  capabilities: z.array(capabilitySchema),
  nodes: z.array(irNodeSchema),
  edges: z.array(irEdgeSchema),
  operations: z.array(operationSchema),
  declarations: z.array(declarationRecordSchema),
  omissions: z.array(irOmissionSchema),
  evidenceIndex: z.object({ path: z.string().min(1), total: z.number().int().nonnegative() }).strict(),
  projection: z.object({ path: z.string().min(1) }).strict(),
}).strict();
export type ArchitectureIr = z.infer<typeof architectureIrSchema>;

export const projectionManifestSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  view: z.string().min(1),
  outputs: z.array(z.object({ name: z.string().min(1), role: z.string().min(1) }).strict()),
  projection: z.array(z.object({
    ownerType: z.string().min(1),
    ownerId: z.string().min(1),
    evidenceTotal: z.number().int().nonnegative(),
    renderedEvidenceIds: z.array(z.string().min(1)),
    remainingEvidenceIds: z.array(z.string().min(1)),
    selectionReason: z.string().min(1),
  }).strict()),
  totals: z.object({
    owners: z.number().int().nonnegative(),
    evidenceTotal: z.number().int().nonnegative(),
    rendered: z.number().int().nonnegative(),
    hidden: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type ProjectionManifest = z.infer<typeof projectionManifestSchema>;

export interface BuildIrInput {
  revision: string;
  view: string;
  scope: DeclaredScope;
  facts: ArchitectureFactSet;
  evidence: EvidenceIndex;
  declarations: DeclarationInventory;
  census: SourceCensus;
  omissions?: IrOmission[];
}

function ownerFor(paths: string[], census: SourceCensus) {
  for (const path of paths) {
    const record = census.files.find((file) => file.path === path);
    if (record) return record.packageId;
  }
  return "repository";
}

export function buildArchitectureIr(input: BuildIrInput): ArchitectureIr {
  const declarationIdsForPath = (path: string) => input.declarations.declarations
    .filter((declaration) => declaration.sourcePath === path).map((declaration) => declaration.declarationId).sort();
  const nodes = input.facts.nodes.map((node) => {
    const paths = [...(node.sourcePaths ?? []), ...node.evidence.map((item) => item.path)];
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      owner: ownerFor(paths, input.census),
      scope: "runtime-overview",
      resolution: "unknown" as const,
      synthetic: node.synthetic === true,
      sourcePaths: [...new Set(node.sourcePaths ?? [])].sort(),
      evidenceIds: evidenceIdsFor(node.evidence),
      declarationIds: [...new Set(paths.flatMap(declarationIdsForPath))].sort(),
    };
  });
  const edges = input.facts.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    label: edge.label,
    direction: "outbound" as const,
    resolution: "unknown" as const,
    evidenceIds: evidenceIdsFor(edge.evidence),
    declarationIds: [...new Set(edge.evidence.flatMap((item) => declarationIdsForPath(item.path)))].sort(),
  }));
  return architectureIrSchema.parse({
    version: 2,
    revision: input.revision,
    view: input.view,
    declaredScope: input.scope,
    capabilities: repomapCapabilities,
    nodes,
    edges,
    // Operation facts are populated by M3/M4 extractors; the union schema is
    // defined now so that adding them is not a breaking change.
    operations: [],
    declarations: input.declarations.declarations,
    omissions: input.omissions ?? [],
    evidenceIndex: { path: "architecture.evidence.json", total: input.evidence.statistics.total },
    projection: { path: "architecture.projection.json" },
  });
}

export function buildProjectionManifest(input: { revision: string; view: string; evidence: EvidenceIndex; ir: ArchitectureIr }): ProjectionManifest {
  const projections = input.evidence.references.map((reference) => ({
    ownerType: reference.ownerType,
    ownerId: reference.ownerId,
    evidenceTotal: reference.evidenceIds.length,
    renderedEvidenceIds: reference.renderedEvidenceIds,
    remainingEvidenceIds: reference.remainingEvidenceIds,
    selectionReason: reference.selectionReason,
  }));
  return projectionManifestSchema.parse({
    version: 1,
    revision: input.revision,
    view: input.view,
    outputs: [
      { name: "architecture.facts.json", role: "v1 compatibility projection" },
      { name: "architecture.ir.json", role: "lossless semantic IR v2" },
      { name: "architecture.evidence.json", role: "lossless evidence index" },
      { name: "architecture.source-census.json", role: "raw entry dispositions" },
      { name: "architecture.declarations.json", role: "independent declaration inventory" },
      { name: "architecture.project.json", role: "immutable raw snapshot, project units and parser capabilities" },
      { name: "architecture.module-graph.json", role: "TypeScript/JavaScript module graph, cycles and AST import evidence" },
      { name: "architecture.projection.json", role: "projection reconciliation manifest" },
      { name: "architecture.analysis.json", role: "signal inventory and coverage" },
      { name: "repomap.receipt.json", role: "delivery and cost receipt" },
    ],
    projection: projections,
    totals: {
      owners: projections.length,
      evidenceTotal: projections.reduce((total, entry) => total + entry.evidenceTotal, 0),
      rendered: projections.reduce((total, entry) => total + entry.renderedEvidenceIds.length, 0),
      hidden: input.evidence.statistics.hiddenEvidenceCount,
    },
  });
}

export function irEvidenceIds(ir: ArchitectureIr) {
  return [
    ...ir.nodes.flatMap((node) => node.evidenceIds),
    ...ir.edges.flatMap((edge) => edge.evidenceIds),
    ...ir.operations.flatMap((operation) => operation.evidenceIds),
    ...ir.omissions.flatMap((omission) => omission.evidenceIds),
    ...ir.declarations.flatMap((declaration) => declaration.evidenceIds),
  ];
}
