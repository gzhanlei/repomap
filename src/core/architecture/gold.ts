import { z } from "zod";
import type { analyzeArchitectureFacts } from "./extract.js";

export const criticalGoldFactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["node", "edge", "operation", "declaration"]),
  expectedId: z.string().min(1),
  direction: z.enum(["outbound", "inbound", "uncertain"]).optional(),
  evidencePath: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
}).strict();
export type CriticalGoldFact = z.infer<typeof criticalGoldFactSchema>;

export const criticalGoldSetSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  facts: z.array(criticalGoldFactSchema),
  knownFalsePositiveIds: z.array(z.string().min(1)),
}).strict();
export type CriticalGoldSet = z.infer<typeof criticalGoldSetSchema>;

export const criticalGoldEvaluationSchema = z.object({
  passed: z.boolean(),
  total: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
  missing: z.array(z.string().min(1)),
  falsePositives: z.array(z.string().min(1)),
  evidenceInvalid: z.array(z.string().min(1)),
}).strict();
export type CriticalGoldEvaluation = z.infer<typeof criticalGoldEvaluationSchema>;

export function evaluateCriticalGold(analysis: ReturnType<typeof analyzeArchitectureFacts>, gold: CriticalGoldSet): CriticalGoldEvaluation {
  const missing: string[] = [];
  const falsePositives: string[] = [];
  const evidenceInvalid: string[] = [];
  if (gold.revision !== analysis.ir.revision) {
    return criticalGoldEvaluationSchema.parse({ passed: false, total: gold.facts.length, covered: 0, missing: gold.facts.map((fact) => fact.id), falsePositives, evidenceInvalid: ["gold revision does not match analysis revision"] });
  }
  const factsById = new Map<string, { direction?: string; action?: string; evidenceIds: string[] }>();
  for (const node of analysis.ir.nodes) factsById.set(node.id, { evidenceIds: node.evidenceIds });
  for (const edge of analysis.ir.edges) factsById.set(edge.id, { direction: edge.direction, evidenceIds: edge.evidenceIds });
  for (const operation of analysis.ir.operations) factsById.set(operation.id, { action: operation.action, evidenceIds: operation.evidenceIds });
  for (const declaration of analysis.ir.declarations) factsById.set(declaration.declarationId, { evidenceIds: declaration.evidenceIds });
  const evidenceById = new Map(analysis.evidence.records.map((record) => [record.id, record.path]));
  for (const fact of gold.facts) {
    const actual = factsById.get(fact.expectedId);
    if (!actual) {
      missing.push(fact.id);
      continue;
    }
    if (fact.direction && actual.direction !== fact.direction) evidenceInvalid.push(`${fact.id}: direction ${actual.direction ?? "missing"} != ${fact.direction}`);
    if (fact.action && actual.action !== fact.action) evidenceInvalid.push(`${fact.id}: action ${actual.action ?? "missing"} != ${fact.action}`);
    if (fact.evidencePath && !actual.evidenceIds.some((id) => evidenceById.get(id) === fact.evidencePath)) evidenceInvalid.push(`${fact.id}: evidence path ${fact.evidencePath} is not present`);
  }
  const ids = new Set(factsById.keys());
  for (const id of gold.knownFalsePositiveIds) if (ids.has(id)) falsePositives.push(id);
  return criticalGoldEvaluationSchema.parse({
    passed: missing.length === 0 && falsePositives.length === 0 && evidenceInvalid.length === 0,
    total: gold.facts.length,
    covered: gold.facts.length - missing.length,
    missing,
    falsePositives,
    evidenceInvalid,
  });
}
