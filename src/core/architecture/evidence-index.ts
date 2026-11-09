import { createHash } from "node:crypto";
import { z } from "zod";
import { architectureFactSetSchema, type ArchitectureEvidence, type ArchitectureFactSet } from "./facts.js";

/** M1: the lossless evidence index. facts v1 keeps its strict inline schema. */
export const evidenceRoleSchema = z.enum(["declaration", "runtime-call", "configuration", "schema", "migration", "inferred-default"]);
export type EvidenceRole = z.infer<typeof evidenceRoleSchema>;
export const evidenceSourceSchema = z.enum(["parser", "regex"]);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceRecordSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  extractor: z.string().min(1),
  role: evidenceRoleSchema,
  source: evidenceSourceSchema,
}).strict();
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

const evidenceReferenceSchema = z.object({
  ownerType: z.enum(["node", "edge", "operation"]),
  ownerId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  renderedEvidenceIds: z.array(z.string().min(1)),
  remainingEvidenceIds: z.array(z.string().min(1)),
  selectionReason: z.string().min(1),
}).strict();

export const evidenceIndexSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  records: z.array(evidenceRecordSchema),
  references: z.array(evidenceReferenceSchema),
  statistics: z.object({
    total: z.number().int().nonnegative(),
    duplicatesRemoved: z.number().int().nonnegative(),
    byRole: z.record(z.string(), z.number().int().nonnegative()),
    bySource: z.record(z.string(), z.number().int().nonnegative()),
    renderLimit: z.number().int().positive(),
    hiddenEvidenceCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type EvidenceIndex = z.infer<typeof evidenceIndexSchema>;

export const renderEvidenceLimit = 3;

export function evidenceRole(path: string, extractor: string): EvidenceRole {
  if (/(?:^|\/)(?:migrations?|migrate|alembic|db\/migrate)(?:\/|$)/i.test(path)) return "migration";
  if (/\.prisma$/i.test(path) || /config|default|provider/i.test(path) || /(?:^|[/._-])env(?:[/._-]|$)/i.test(path) || /\.(?:ya?ml|toml|ini|properties)$/i.test(path) || /config|default|provider/i.test(extractor)) return "configuration";
  if (/\.(?:sql|graphql|gql)$/i.test(path) || /schema/i.test(extractor)) return "schema";
  if (/call|caller|usage|client|request|fetch|external|outbound|http|poll|worker|queue|enqueue|consume/i.test(extractor)) return "runtime-call";
  if (/inferred|fallback/i.test(extractor)) return "inferred-default";
  return "declaration";
}

export function evidenceSource(extractor: string): EvidenceSource {
  return /^(?:ast|parser)[-:]/.test(extractor) ? "parser" : "regex";
}

export function evidenceRecord(evidence: ArchitectureEvidence): EvidenceRecord {
  const role = evidenceRole(evidence.path, evidence.detector);
  const source = evidenceSource(evidence.detector);
  const key = `${evidence.path}|${evidence.line}|${evidence.line}|${evidence.detector}|${role}|${source}`;
  return {
    id: `ev:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
    path: evidence.path,
    startLine: evidence.line,
    endLine: evidence.line,
    extractor: evidence.detector,
    role,
    source,
  };
}

export function evidenceIdsFor(evidence: ArchitectureEvidence[]) {
  return [...new Set(evidence.map((item) => evidenceRecord(item).id))].sort();
}

export function buildEvidenceIndex(revision: string, factsInput: ArchitectureFactSet): EvidenceIndex {
  const facts = architectureFactSetSchema.parse(factsInput);
  const owners = [
    ...facts.nodes.map((node) => ({ ownerType: "node" as const, ownerId: node.id, evidence: node.evidence })),
    ...facts.edges.map((edge) => ({ ownerType: "edge" as const, ownerId: edge.id, evidence: edge.evidence })),
  ];
  const records = new Map<string, EvidenceRecord>();
  let seen = 0;
  for (const owner of owners) {
    for (const item of owner.evidence) {
      seen += 1;
      const record = evidenceRecord(item);
      const key = `${record.path}:${record.startLine}:${record.endLine}:${record.extractor}:${record.role}:${record.source}`;
      if (!records.has(key)) records.set(key, record);
    }
  }
  const sorted = [...records.values()].sort((a, b) => `${a.path}:${a.startLine}:${a.extractor}:${a.role}`.localeCompare(`${b.path}:${b.startLine}:${b.extractor}:${b.role}`));
  const references = owners.map((owner) => {
    const ids = evidenceIdsFor(owner.evidence);
    return {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      evidenceIds: ids,
      renderedEvidenceIds: ids.slice(0, renderEvidenceLimit),
      remainingEvidenceIds: ids.slice(renderEvidenceLimit),
      selectionReason: "first N deterministic evidence IDs by id order; full set retained in evidenceIds and in the index",
    };
  });
  return evidenceIndexSchema.parse({
    version: 1,
    revision,
    records: sorted,
    references,
    statistics: {
      total: sorted.length,
      duplicatesRemoved: seen - sorted.length,
      byRole: Object.fromEntries(evidenceRoleSchema.options.map((role) => [role, sorted.filter((record) => record.role === role).length])),
      bySource: Object.fromEntries(evidenceSourceSchema.options.map((source) => [source, sorted.filter((record) => record.source === source).length])),
      renderLimit: renderEvidenceLimit,
      hiddenEvidenceCount: references.reduce((total, item) => total + item.remainingEvidenceIds.length, 0),
    },
  });
}

export function assertEvidenceReferences(index: EvidenceIndex, ids: Iterable<string>) {
  const known = new Set(index.records.map((record) => record.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Dangling architecture evidence reference: ${id}`);
  }
}
