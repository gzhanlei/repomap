import { z } from "zod";

export const architectureEvidenceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  detector: z.string().min(1),
}).strict();

export const architectureNodeKindSchema = z.enum(["user", "frontend", "api", "worker", "agent", "cli", "database", "object-store", "queue", "external"]);
export const architectureEdgeKindSchema = z.enum(["http", "sql", "poll", "schedule", "upload", "download", "oauth", "callback", "file", "process"]);

export const architectureNodeFactSchema = z.object({
  id: z.string().min(1),
  kind: architectureNodeKindSchema,
  label: z.string().min(1),
  runtimeUnit: z.string().min(1).optional(),
  sourcePaths: z.array(z.string().min(1)).optional(),
  synthetic: z.literal(true).optional(),
  signalIds: z.array(z.string().min(1)),
  evidence: z.array(architectureEvidenceSchema),
}).strict();

export const architectureEdgeFactSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: architectureEdgeKindSchema,
  label: z.string().min(1),
  signalIds: z.array(z.string().min(1)),
  evidence: z.array(architectureEvidenceSchema),
}).strict();

export const architectureOmissionSchema = z.object({
  signalId: z.string().min(1),
  reason: z.enum(["unsupported", "out-of-scope", "duplicate", "uncertain"]),
  detail: z.string().min(1),
}).strict();

const baseFactSetSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  roots: z.array(z.string().min(1)),
  nodes: z.array(architectureNodeFactSchema),
  edges: z.array(architectureEdgeFactSchema),
  omissions: z.array(architectureOmissionSchema),
}).strict();

type FactSetInput = z.infer<typeof baseFactSetSchema>;

function duplicateIds(ids: string[]) {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

function validateUniqueIds(value: FactSetInput, context: z.RefinementCtx) {
  for (const [field, ids] of [["nodes", value.nodes.map((node) => node.id)], ["edges", value.edges.map((edge) => edge.id)], ["roots", value.roots]] as const) {
    for (const id of duplicateIds(ids)) context.addIssue({ code: "custom", message: `Duplicate architecture ${field} id: ${id}` });
  }
}

function validateReferences(value: FactSetInput, context: z.RefinementCtx) {
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  for (const root of value.roots) {
    if (!nodeIds.has(root)) context.addIssue({ code: "custom", message: `Unknown architecture root: ${root}` });
  }
  for (const edge of value.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!nodeIds.has(endpoint)) context.addIssue({ code: "custom", message: `Unknown architecture edge endpoint: ${endpoint}` });
    }
  }
}

export const architectureFactSetSchema = baseFactSetSchema.superRefine((value, context) => {
  validateUniqueIds(value, context);
  validateReferences(value, context);
});

export type ArchitectureEvidence = z.infer<typeof architectureEvidenceSchema>;
export type NodeFact = z.infer<typeof architectureNodeFactSchema>;
export type EdgeFact = z.infer<typeof architectureEdgeFactSchema>;
export type ArchitectureOmission = z.infer<typeof architectureOmissionSchema>;
export type ArchitectureFactSet = z.infer<typeof baseFactSetSchema>;
