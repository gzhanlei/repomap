import { createHash } from "node:crypto";
import { z } from "zod";
import { operationSchema, irOmissionSchema, type IrOmission, type OperationFact } from "../ir.js";
import { evidenceRecordSchema, type EvidenceRecord } from "../evidence-index.js";
import { architectureViewSchema } from "../scope.js";

export const asyncDeclarationSchema = z.object({ id: z.string().min(1), path: z.string().min(1), line: z.number().int().positive() }).strict();
export type AsyncDeclaration = z.infer<typeof asyncDeclarationSchema>;

export const asyncGraphSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  snapshotId: z.string().min(1),
  operations: z.array(operationSchema),
  declarations: z.array(asyncDeclarationSchema),
  coverage: z.object({
    expected: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    missing: z.array(asyncDeclarationSchema),
  }).strict(),
  omissions: z.array(irOmissionSchema),
  gates: z.object({
    blockedViews: z.array(architectureViewSchema),
    runtimeOverviewUnaffected: z.literal(true),
    reasons: z.array(z.string()),
  }).strict(),
  statistics: z.object({
    operations: z.number().int().nonnegative(),
    byAction: z.record(z.string(), z.number().int().nonnegative()),
    evidenceRecords: z.number().int().nonnegative(),
  }).strict(),
  evidenceRecords: z.array(evidenceRecordSchema),
}).strict();
export type AsyncGraph = z.infer<typeof asyncGraphSchema>;

export interface AsyncExtraction {
  operations: OperationFact[];
  declarations: AsyncDeclaration[];
  omissions: IrOmission[];
  evidenceRecords: EvidenceRecord[];
}

export function emptyAsyncExtraction(): AsyncExtraction {
  return { operations: [], declarations: [], omissions: [], evidenceRecords: [] };
}

export function asyncDeclarationId(action: string, path: string, line: number, topic: string) {
  return `async:${createHash("sha256").update(`${action}|${path}|${line}|${topic}`).digest("hex").slice(0, 16)}`;
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildAsyncGraph(input: { revision: string; snapshotId: string; extractions: AsyncExtraction[] }): AsyncGraph {
  const operations = uniqueById(input.extractions.flatMap((item) => item.operations));
  const declarations = uniqueById(input.extractions.flatMap((item) => item.declarations));
  const covered = new Set(operations.flatMap((operation) => operation.declarationIds));
  const missing = declarations.filter((declaration) => !covered.has(declaration.id));
  const omissions = uniqueById(input.extractions.flatMap((item) => item.omissions));
  const blocked = missing.length > 0 || omissions.some((omission) => omission.blocking && omission.affectedViews.some((view) => ["protocol-flows", "full-declared-scope"].includes(view)));
  const byAction = Object.fromEntries([...new Set(operations.flatMap((operation) => operation.action ? [operation.action] : []))].sort().map((action) => [action, operations.filter((operation) => operation.action === action).length]));
  return asyncGraphSchema.parse({
    version: 1,
    revision: input.revision,
    snapshotId: input.snapshotId,
    operations,
    declarations,
    coverage: { expected: declarations.length, resolved: declarations.length - missing.length, missing },
    omissions,
    gates: {
      blockedViews: blocked ? ["protocol-flows", "full-declared-scope"] : [],
      runtimeOverviewUnaffected: true,
      reasons: blocked ? [`${missing.length} async declaration(s) have no semantic operation`] : [],
    },
    statistics: {
      operations: operations.length,
      byAction,
      evidenceRecords: uniqueById(input.extractions.flatMap((item) => item.evidenceRecords)).length,
    },
    evidenceRecords: uniqueById(input.extractions.flatMap((item) => item.evidenceRecords)),
  });
}
