import { z } from "zod";
import type { analyzeArchitectureFacts } from "./extract.js";
import { architectureViewSchema, type ArchitectureView } from "./scope.js";
import { irEvidenceIds, type ProjectionManifest } from "./ir.js";
import { evaluateCriticalGold, type CriticalGoldSet } from "./gold.js";

export const viewGateStatusSchema = z.enum(["passed", "failed"]);
export const viewGateResultSchema = z.object({
  status: viewGateStatusSchema,
  blockingReasons: z.array(z.string().min(1)),
  omissionCount: z.number().int().nonnegative(),
  metrics: z.record(z.string(), z.number().int().nonnegative()),
}).strict();
export type ViewGateResult = z.infer<typeof viewGateResultSchema>;

export const architectureViewEvaluationSchema = z.object({
  views: z.record(architectureViewSchema, viewGateResultSchema),
  fullArchitecture: z.boolean(),
}).strict();
export type ArchitectureViewEvaluation = z.infer<typeof architectureViewEvaluationSchema>;

type Analysis = ReturnType<typeof analyzeArchitectureFacts>;

export interface ViewEvaluationOptions {
  strictExternalHosts?: boolean;
  projection?: ProjectionManifest;
  independence?: { passed: boolean; reason?: string };
  gold?: CriticalGoldSet;
}

function gate(status: ViewGateResult["status"], blockingReasons: string[], metrics: ViewGateResult["metrics"]): ViewGateResult {
  return viewGateResultSchema.parse({ status, blockingReasons, omissionCount: blockingReasons.length, metrics });
}

function strictFailures(analysis: Analysis, strict: boolean) {
  if (!strict) return [];
  return analysis.candidates.filter((candidate) => candidate.status === "omitted" || candidate.target?.kind !== "host" || candidate.target.resolution !== "static").map((candidate) => `external host is not static: ${candidate.id}`);
}

function operationEvidenceFailures(analysis: Analysis) {
  const known = new Set(analysis.evidence.records.map((record) => record.id));
  return analysis.ir.operations.flatMap((operation) => operation.evidenceIds.filter((id) => !known.has(id)).map((id) => `operation ${operation.id} has dangling evidence ${id}`));
}

function projectionFailures(analysis: Analysis, projection: ProjectionManifest) {
  const reasons: string[] = [];
  const references = analysis.evidence.references;
  const total = references.reduce((sum, reference) => sum + reference.evidenceIds.length, 0);
  const rendered = references.reduce((sum, reference) => sum + reference.renderedEvidenceIds.length, 0);
  const hidden = references.reduce((sum, reference) => sum + reference.remainingEvidenceIds.length, 0);
  if (projection.totals.owners !== references.length) reasons.push("projection owner count does not reconcile with evidence references");
  if (projection.totals.evidenceTotal !== total) reasons.push("projection evidence total does not reconcile with evidence references");
  if (projection.totals.rendered !== rendered) reasons.push("projection rendered evidence count does not reconcile");
  if (projection.totals.hidden !== hidden || projection.totals.hidden !== analysis.evidence.statistics.hiddenEvidenceCount) reasons.push("projection remaining evidence count does not reconcile");
  if (projection.totals.rendered + projection.totals.hidden !== total) reasons.push("projection rendered plus remaining evidence does not equal total");
  const known = new Set(analysis.evidence.records.map((record) => record.id));
  for (const entry of projection.projection) {
    if (entry.renderedEvidenceIds.length + entry.remainingEvidenceIds.length !== entry.evidenceTotal) reasons.push(`projection owner ${entry.ownerId} has incomplete evidence partition`);
    for (const id of [...entry.renderedEvidenceIds, ...entry.remainingEvidenceIds]) {
      if (!known.has(id)) reasons.push(`projection owner ${entry.ownerId} has dangling evidence ${id}`);
    }
  }
  for (const id of irEvidenceIds(analysis.ir)) if (!known.has(id)) reasons.push(`IR has dangling evidence ${id}`);
  return reasons;
}

export function evaluateArchitectureViews(analysis: Analysis, options: ViewEvaluationOptions = {}): ArchitectureViewEvaluation {
  const strict = strictFailures(analysis, options.strictExternalHosts === true);
  const unknownExternal = analysis.candidates.filter((candidate) => candidate.status === "omitted").map((candidate) => `unknown external identity: ${candidate.id}`);
  const runtimeReasons = [
    ...(analysis.coverage.publishable ? [] : ["runtime coverage gate failed"]),
    ...(analysis.census.rawBudgetExceeded ? ["raw source budget exceeded"] : []),
    ...(analysis.declarationCoverage.blockingViews.includes("runtime-overview") ? ["runtime declaration coverage failed"] : []),
    ...analysis.omissions.filter((omission) => omission.blocking && omission.affectedViews.includes("runtime-overview")).map((omission) => omission.detail),
    ...strict,
  ];
  const systemReasons = [
    ...unknownExternal,
    ...strict,
    ...(analysis.facts.roots.length === 0 ? ["system context has no roots"] : []),
    ...analysis.omissions.filter((omission) => omission.blocking && omission.affectedViews.includes("system-context")).map((omission) => omission.detail),
  ];
  const moduleReasons = [
    ...analysis.project.gates.blockedViews.filter((view) => view === "module-architecture").map(() => "project parser gate blocks module architecture"),
    ...analysis.moduleGraph.gates.blockedViews.filter((view) => view === "module-architecture").map(() => "TypeScript module graph gate failed"),
    ...analysis.goModuleGraph.gates.blockedViews.filter((view) => view === "module-architecture").map(() => "Go module graph gate failed"),
    ...analysis.routeGraph.gates.blockedViews.filter((view) => view === "module-architecture").map(() => "route handler gate failed"),
    ...analysis.moduleGraph.unresolvedImports.map((item) => `unresolved import ${item.path}:${item.line}`),
    ...analysis.goModuleGraph.unresolvedImports.map((item) => `unresolved Go import ${item.path}:${item.line}`),
    ...analysis.moduleGraph.importDeclarations.missing.map((item) => `missing TypeScript import declaration ${item.id}`),
    ...analysis.goModuleGraph.importDeclarations.missing.map((item) => `missing Go import declaration ${item.id}`),
    ...analysis.omissions.filter((omission) => omission.blocking && omission.affectedViews.includes("module-architecture")).map((omission) => omission.detail),
  ];
  if (analysis.moduleGraph.nodes.length === 0 && analysis.goModuleGraph.nodes.length === 0) moduleReasons.push("no module/package graph nodes");
  if (analysis.routeGraph.coverage.missing.length > 0) moduleReasons.push(`${analysis.routeGraph.coverage.missing.length} route declarations have no resolved handler`);
  const flowReasons = [
    ...analysis.routeGraph.gates.blockedViews.filter((view) => view === "protocol-flows").map(() => "route protocol gate failed"),
    ...analysis.asyncGraph.gates.blockedViews.filter((view) => view === "protocol-flows").map(() => "async protocol gate failed"),
    ...analysis.routeGraph.coverage.missing.map((item) => `missing route handler declaration ${item.id}`),
    ...analysis.asyncGraph.coverage.missing.map((item) => `missing async declaration ${item.id}`),
    ...unknownExternal,
    ...operationEvidenceFailures(analysis),
    ...analysis.omissions.filter((omission) => omission.blocking && omission.affectedViews.includes("protocol-flows")).map((omission) => omission.detail),
  ];
  if (analysis.ir.operations.length === 0) flowReasons.push("no protocol operations");
  const projection = options.projection ?? analysis.projection;
  const projectionReasons = projectionFailures(analysis, projection);
  const independenceReasons = options.independence && !options.independence.passed ? [options.independence.reason ?? "independent mutation suite failed"] : [];
  const goldEvaluation = options.gold ? evaluateCriticalGold(analysis, options.gold) : undefined;
  const goldReasons = goldEvaluation && !goldEvaluation.passed
    ? [`critical gold evaluation failed: ${[...goldEvaluation.missing, ...goldEvaluation.falsePositives, ...goldEvaluation.evidenceInvalid].join(", ")}`]
    : [];
  const fullReasons = [
    ...runtimeReasons,
    ...systemReasons,
    ...moduleReasons,
    ...flowReasons,
    ...projectionReasons,
    ...independenceReasons,
    ...goldReasons,
    ...(analysis.mutation.passed ? [] : ["independent declaration mutation check failed"]),
    ...(analysis.census.reconciled ? [] : ["raw census is not reconciled"]),
  ];
  const views: Record<ArchitectureView, ViewGateResult> = {
    "system-context": gate(systemReasons.length === 0 ? "passed" : "failed", systemReasons, { candidates: analysis.candidates.length, unknown: unknownExternal.length, strictHostFailures: strict.length }),
    "runtime-overview": gate(runtimeReasons.length === 0 ? "passed" : "failed", runtimeReasons, { declarations: analysis.declarationCoverage.total, missingDeclarations: analysis.declarationCoverage.missing.length, strictHostFailures: strict.length }),
    "module-architecture": gate(moduleReasons.length === 0 ? "passed" : "failed", moduleReasons, { modules: analysis.moduleGraph.nodes.length, goPackages: analysis.goModuleGraph.nodes.length, unresolvedImports: analysis.moduleGraph.unresolvedImports.length + analysis.goModuleGraph.unresolvedImports.length, missingRoutes: analysis.routeGraph.coverage.missing.length }),
    "protocol-flows": gate(flowReasons.length === 0 ? "passed" : "failed", flowReasons, { operations: analysis.ir.operations.length, missingRoutes: analysis.routeGraph.coverage.missing.length, missingAsync: analysis.asyncGraph.coverage.missing.length, evidenceFailures: operationEvidenceFailures(analysis).length }),
    "full-declared-scope": gate(fullReasons.length === 0 ? "passed" : "failed", fullReasons, { projectionFailures: projectionReasons.length, independenceFailures: independenceReasons.length, goldFailures: goldReasons.length }),
  };
  return architectureViewEvaluationSchema.parse({ views, fullArchitecture: Object.values(views).every((view) => view.status === "passed") });
}
