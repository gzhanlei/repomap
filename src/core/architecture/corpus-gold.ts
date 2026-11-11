import { z } from "zod";

// M7 targeted Gold: human-authored semantic facts matched against written
// analysis artifacts. Facts never reference generated hash ids; matchers use
// fields a human can read off the source (method, path, sourcePath, callSite).

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);

const routeFactSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("route"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string().min(1),
  sourcePath: z.string().min(1),
  line: z.number().int().positive().optional(),
  evidencePath: z.string().min(1).optional(),
}).strict();

const routeHandlerFactSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("route-handler"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string().min(1),
  handlerSourcePath: z.string().min(1),
  evidencePath: z.string().min(1).optional(),
}).strict();

const sqlOperationFactSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("sql-operation"),
  action: z.enum(["read", "write", "transaction", "migration"]),
  callSite: z.string().min(1),
  driver: z.string().min(1).optional(),
  evidencePath: z.string().min(1).optional(),
}).strict();

const asyncOperationFactSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("async-operation"),
  action: z.string().min(1),
  callSite: z.string().min(1),
  topic: z.string().min(1).optional(),
  evidencePath: z.string().min(1).optional(),
}).strict();

const declarationFactSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("declaration"),
  sourcePath: z.string().min(1),
  detail: z.string().min(1),
  evidencePath: z.string().min(1).optional(),
}).strict();

export const goldFactSchema = z.discriminatedUnion("kind", [
  routeFactSchema,
  routeHandlerFactSchema,
  sqlOperationFactSchema,
  asyncOperationFactSchema,
  declarationFactSchema,
]);
export type GoldFact = z.infer<typeof goldFactSchema>;

const routeScopeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("route"),
  sourcePathPrefix: z.string().min(1),
}).strict();

const sqlOperationScopeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("sql-operation"),
  callSitePrefix: z.string().min(1),
}).strict();

const asyncOperationScopeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("async-operation"),
  callSitePrefix: z.string().min(1),
}).strict();

const declarationScopeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("declaration"),
  sourcePathPrefix: z.string().min(1),
}).strict();

export const precisionScopeSchema = z.discriminatedUnion("kind", [
  routeScopeSchema,
  sqlOperationScopeSchema,
  asyncOperationScopeSchema,
  declarationScopeSchema,
]);
export type PrecisionScope = z.infer<typeof precisionScopeSchema>;

export const corpusGoldSetSchema = z.object({
  version: z.literal(1),
  corpusId: z.string().min(1),
  revision: revisionSchema,
  auditedBy: z.string().min(1),
  auditedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  facts: z.array(goldFactSchema),
  precisionScopes: z.array(precisionScopeSchema),
}).strict();
export type CorpusGoldSet = z.infer<typeof corpusGoldSetSchema>;

export interface CorpusGoldArtifacts {
  revision: string;
  routes: Array<{ id: string; method: string; path: string; sourcePath: string; line?: number; evidenceIds: string[] }>;
  routeHandlers: Array<{ id: string; sourcePath: string; line?: number; evidenceIds: string[] }>;
  routeEdges: Array<{ id: string; from: string; to: string; kind: string; evidenceIds: string[] }>;
  sqlOperations: Array<{ id: string; action: string; callSite: string; driver?: string; evidenceIds: string[] }>;
  asyncOperations: Array<{ id: string; action: string; callSite: string; topic?: string; evidenceIds: string[] }>;
  declarations: Array<{ declarationId: string; sourcePath: string; detail: string; evidenceIds: string[] }>;
  evidencePathsById: Map<string, string>;
  omissions: { routeGraph: number; asyncGraph: number; ir: number };
}

export const corpusGoldEvaluationSchema = z.object({
  corpusId: z.string().min(1),
  revision: z.string(),
  passed: z.boolean(),
  recall: z.object({
    total: z.number().int().nonnegative(),
    covered: z.number().int().nonnegative(),
    missing: z.array(z.object({ id: z.string(), kind: z.string() }).strict()),
    byKind: z.record(z.string(), z.object({ total: z.number().int().nonnegative(), covered: z.number().int().nonnegative(), missing: z.number().int().nonnegative() }).strict()),
    dimensions: z.object({
      node: z.object({ total: z.number().int().nonnegative(), covered: z.number().int().nonnegative(), missing: z.number().int().nonnegative() }).strict(),
      edge: z.object({ total: z.number().int().nonnegative(), covered: z.number().int().nonnegative(), missing: z.number().int().nonnegative() }).strict(),
      direction: z.object({ total: z.number().int().nonnegative(), covered: z.number().int().nonnegative(), missing: z.number().int().nonnegative() }).strict(),
    }).strict(),
  }).strict(),
  precision: z.object({
    scopes: z.array(z.object({
      id: z.string(),
      outputRecords: z.number().int().nonnegative(),
      matched: z.number().int().nonnegative(),
    }).strict()),
    suspectedFalsePositives: z.array(z.string().min(1)),
  }).strict(),
  evidence: z.object({
    checked: z.number().int().nonnegative(),
    invalid: z.array(z.object({ factId: z.string(), reason: z.string() }).strict()),
  }).strict(),
  omissions: z.object({ routeGraph: z.number(), asyncGraph: z.number(), ir: z.number() }).strict(),
});
export type CorpusGoldEvaluation = z.infer<typeof corpusGoldEvaluationSchema>;

function routeMatches(record: CorpusGoldArtifacts["routes"][number], fact: z.infer<typeof routeFactSchema>): boolean {
  return record.method === fact.method && record.path === fact.path && record.sourcePath === fact.sourcePath && (fact.line === undefined || record.line === fact.line);
}

function evaluateFact(fact: GoldFact, artifacts: CorpusGoldArtifacts): { covered: boolean; evidenceInvalid?: string } {
  let record: { evidenceIds: string[] } | undefined;
  switch (fact.kind) {
    case "route": {
      const match = artifacts.routes.find((item) => routeMatches(item, fact));
      record = match;
      break;
    }
    case "route-handler": {
      const route = artifacts.routes.find((item) => item.method === fact.method && item.path === fact.path);
      if (!route) break;
      const edge = artifacts.routeEdges.find((item) => item.kind === "routes-to" && item.from === route.id);
      if (!edge) break;
      const handler = artifacts.routeHandlers.find((item) => item.id === edge.to && item.sourcePath === fact.handlerSourcePath);
      record = handler;
      break;
    }
    case "sql-operation": {
      const match = artifacts.sqlOperations.find((item) => item.action === fact.action && item.callSite === fact.callSite && (fact.driver === undefined || item.driver === fact.driver));
      record = match;
      break;
    }
    case "async-operation": {
      const match = artifacts.asyncOperations.find((item) => item.action === fact.action && item.callSite === fact.callSite && (fact.topic === undefined || item.topic === fact.topic));
      record = match;
      break;
    }
    case "declaration": {
      const match = artifacts.declarations.find((item) => item.sourcePath === fact.sourcePath && item.detail === fact.detail);
      record = match;
      break;
    }
  }
  if (!record) return { covered: false };
  if (fact.evidencePath) {
    const hasEvidence = record.evidenceIds.some((id) => artifacts.evidencePathsById.get(id) === fact.evidencePath);
    if (!hasEvidence) return { covered: true, evidenceInvalid: `evidence path ${fact.evidencePath} is not present on the matched record` };
  }
  return { covered: true };
}

function scopeRecords(scope: PrecisionScope, artifacts: CorpusGoldArtifacts): Array<{ id: string; evidenceIds: string[]; matches: (fact: GoldFact) => boolean }> {
  switch (scope.kind) {
    case "route":
      return artifacts.routes.filter((item) => item.sourcePath.startsWith(scope.sourcePathPrefix)).map((item) => ({ ...item, matches: (fact: GoldFact) => fact.kind === "route" && routeMatches(item, fact) }));
    case "sql-operation":
      return artifacts.sqlOperations.filter((item) => item.callSite.startsWith(scope.callSitePrefix)).map((item) => ({ ...item, matches: (fact: GoldFact) => fact.kind === "sql-operation" && item.action === fact.action && item.callSite === fact.callSite && (fact.driver === undefined || item.driver === fact.driver) }));
    case "async-operation":
      return artifacts.asyncOperations.filter((item) => item.callSite.startsWith(scope.callSitePrefix)).map((item) => ({ ...item, matches: (fact: GoldFact) => fact.kind === "async-operation" && item.action === fact.action && item.callSite === fact.callSite && (fact.topic === undefined || item.topic === fact.topic) }));
    case "declaration":
      return artifacts.declarations.filter((item) => item.sourcePath.startsWith(scope.sourcePathPrefix)).map((item) => ({ id: item.declarationId, evidenceIds: item.evidenceIds, matches: (fact: GoldFact) => fact.kind === "declaration" && item.sourcePath === fact.sourcePath && item.detail === fact.detail }));
  }
}

function countByKind(facts: GoldFact[]): Map<string, { total: number; covered: number; missing: number }> {
  const byKind = new Map<string, { total: number; covered: number; missing: number }>();
  for (const fact of facts) {
    const entry = byKind.get(fact.kind) ?? { total: 0, covered: 0, missing: 0 };
    entry.total += 1;
    byKind.set(fact.kind, entry);
  }
  return byKind;
}

export function evaluateCorpusGold(artifacts: CorpusGoldArtifacts, gold: CorpusGoldSet): CorpusGoldEvaluation {
  if (gold.revision !== artifacts.revision) {
    const missing = gold.facts.map((fact) => ({ id: fact.id, kind: fact.kind }));
    return corpusGoldEvaluationSchema.parse({
      corpusId: gold.corpusId,
      revision: artifacts.revision,
      passed: false,
      recall: { total: gold.facts.length, covered: 0, missing, byKind: Object.fromEntries([...countByKind(gold.facts)].map(([kind, entry]) => [kind, { ...entry, missing: entry.total }])), dimensions: { node: { total: 0, covered: 0, missing: 0 }, edge: { total: 0, covered: 0, missing: 0 }, direction: { total: 0, covered: 0, missing: 0 } } },
      precision: { scopes: [], suspectedFalsePositives: [] },
      evidence: { checked: 0, invalid: [] },
      omissions: artifacts.omissions,
    });
  }

  const missing: Array<{ id: string; kind: string }> = [];
  const evidenceInvalid: Array<{ factId: string; reason: string }> = [];
  const byKind = countByKind(gold.facts);
  let evidenceChecked = 0;
  for (const fact of gold.facts) {
    const result = evaluateFact(fact, artifacts);
    if (!result.covered) {
      missing.push({ id: fact.id, kind: fact.kind });
      const entry = byKind.get(fact.kind);
      if (entry) entry.missing += 1;
      continue;
    }
    const entry = byKind.get(fact.kind);
    if (entry) entry.covered += 1;
    if (fact.evidencePath) {
      evidenceChecked += 1;
      if (result.evidenceInvalid) evidenceInvalid.push({ factId: fact.id, reason: result.evidenceInvalid });
    }
  }

  const scopes: CorpusGoldEvaluation["precision"]["scopes"] = [];
  const suspectedFalsePositives: string[] = [];
  for (const scope of gold.precisionScopes) {
    const records = scopeRecords(scope, artifacts);
    let matched = 0;
    for (const record of records) {
      if (gold.facts.some((fact) => record.matches(fact))) {
        matched += 1;
        continue;
      }
      suspectedFalsePositives.push(record.id);
    }
    scopes.push({ id: scope.id, outputRecords: records.length, matched });
  }

  const dimensions = {
    node: {
      total: gold.facts.filter((f) => f.kind !== "route-handler").length,
      covered: gold.facts.filter((f) => f.kind !== "route-handler" && !missing.some((m) => m.id === f.id)).length,
      missing: missing.filter((m) => m.kind !== "route-handler").length,
    },
    edge: {
      total: gold.facts.filter((f) => f.kind === "route-handler").length,
      covered: gold.facts.filter((f) => f.kind === "route-handler" && !missing.some((m) => m.id === f.id)).length,
      missing: missing.filter((m) => m.kind === "route-handler").length,
    },
    direction: {
      total: gold.facts.filter((f) => f.kind === "route-handler").length,
      covered: gold.facts.filter((f) => f.kind === "route-handler" && !missing.some((m) => m.id === f.id)).length,
      missing: missing.filter((m) => m.kind === "route-handler").length,
    },
  };

  return corpusGoldEvaluationSchema.parse({
    corpusId: gold.corpusId,
    revision: artifacts.revision,
    passed: missing.length === 0 && suspectedFalsePositives.length === 0 && evidenceInvalid.length === 0,
    recall: {
      total: gold.facts.length,
      covered: gold.facts.length - missing.length,
      missing,
      byKind: Object.fromEntries([...byKind].map(([kind, entry]) => [kind, { total: entry.total, covered: entry.covered, missing: entry.missing }])),
      dimensions,
    },
    precision: { scopes, suspectedFalsePositives },
    evidence: { checked: evidenceChecked, invalid: evidenceInvalid },
    omissions: artifacts.omissions,
  });
}
