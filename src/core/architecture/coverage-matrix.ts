import { z } from "zod";
import type { analyzeArchitectureFacts } from "./extract.js";
import { architectureViewSchema, type ArchitectureView } from "./scope.js";
import { irEvidenceIds, type OperationFact, type ProjectionManifest } from "./ir.js";
import { evaluateCriticalGold, type CriticalGoldSet } from "./gold.js";
import type { ViewManifest, ViewPage, ViewKind, ViewManifestBuild } from "./view-manifest.js";
import { validateViewManifest } from "./view-manifest.js";

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
  viewManifest?: ViewManifest;
  viewPages?: ViewPage[];
  viewDetails?: ViewManifestBuild["detailFacts"];
}

function operationRequiresFlow(operation: OperationFact) {
  return operation.kind !== "config-binding" && !(operation.kind === "sql" && operation.action === "migration" && operation.owner.startsWith("store:"));
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
  const expectedByOwner = new Map<string, (typeof references)[number]>();
  for (const reference of references) {
    const key = `${reference.ownerType}|${reference.ownerId}`;
    if (expectedByOwner.has(key)) reasons.push(`duplicate evidence reference owner ${key}`);
    expectedByOwner.set(key, reference);
  }
  const actualByOwner = new Map<string, (typeof projection.projection)[number]>();
  for (const entry of projection.projection) {
    const key = `${entry.ownerType}|${entry.ownerId}`;
    if (actualByOwner.has(key)) reasons.push(`projection owner ${key} is duplicated`);
    actualByOwner.set(key, entry);
    const expected = expectedByOwner.get(key);
    if (!expected) {
      reasons.push(`projection owner ${key} has no evidence reference`);
      continue;
    }
    if (entry.evidenceTotal !== expected.evidenceIds.length) reasons.push(`projection owner ${key} has incorrect evidence total`);
    if (entry.renderedEvidenceIds.join("|") !== expected.renderedEvidenceIds.join("|") || entry.remainingEvidenceIds.join("|") !== expected.remainingEvidenceIds.join("|") || entry.selectionReason !== expected.selectionReason) reasons.push(`projection owner ${key} has incorrect evidence mapping`);
    for (const id of [...entry.renderedEvidenceIds, ...entry.remainingEvidenceIds]) {
      if (!known.has(id)) reasons.push(`projection owner ${entry.ownerId} has dangling evidence ${id}`);
    }
  }
  for (const key of expectedByOwner.keys()) if (!actualByOwner.has(key)) reasons.push(`projection owner ${key} is missing`);
  for (const id of irEvidenceIds(analysis.ir)) if (!known.has(id)) reasons.push(`IR has dangling evidence ${id}`);
  return reasons;
}

export function evaluateArchitectureViews(analysis: Analysis, options: ViewEvaluationOptions = {}): ArchitectureViewEvaluation {
  const strict = strictFailures(analysis, options.strictExternalHosts === true);
  const unknownExternal = analysis.candidates.filter((candidate) => candidate.status === "omitted").map((candidate) => `unknown external identity: ${candidate.id}`);
  const manifestReasonsFor = (kind: ViewKind) => {
    if (!options.viewManifest) return [];
    const roundtrip = validateViewManifest(
      {
        ...options.viewManifest,
        detailOwners: kind === "overview" ? [] : options.viewManifest.detailOwners.filter((projection) => (kind === "modules" ? projection.scope === "module-architecture" : projection.scope === "protocol-flows")),
        views: options.viewManifest.views.filter((view) => view.kind === kind),
      },
      (options.viewPages ?? []).filter((page) => page.kind === kind),
      analysis.evidence.records,
      undefined,
      kind === "overview" ? [] : options.viewDetails?.filter((projection) => (kind === "modules" ? projection.scope === "module-architecture" : projection.scope === "protocol-flows")),
    );
    return roundtrip.ok ? [] : [`${kind} view projection reconciliation failed: ${[...roundtrip.missingFactIds, ...roundtrip.duplicateFactIds, ...roundtrip.danglingEvidenceIds].join(", ")}`];
  };
  const overviewManifestReasons = manifestReasonsFor("overview");
  const moduleManifestReasons = manifestReasonsFor("modules");
  const flowManifestReasons = manifestReasonsFor("flows");
  const flowOperationIds = new Set(options.viewDetails
    ? options.viewDetails.filter((projection) => projection.scope === "protocol-flows").flatMap((projection) => projection.operations.map((operation) => operation.id))
    : options.viewManifest?.views.filter((view) => view.kind === "flows").flatMap((view) => view.pages.flatMap((page) => page.operationIds)) ?? []);
  const flowOwnershipFailures = (options.viewManifest || options.viewDetails)
    ? analysis.ir.operations.filter((operation) => operationRequiresFlow(operation) && !flowOperationIds.has(operation.id)).map((operation) => `operation has no protocol flow owner: ${operation.id}`)
    : [];
  const moduleDetailIds = new Set(options.viewDetails
    ? options.viewDetails.filter((projection) => projection.scope === "module-architecture").flatMap((projection) => projection.facts.nodes.map((node) => node.id))
    : options.viewManifest?.views.filter((view) => view.kind === "modules").flatMap((view) => view.pages.flatMap((page) => page.nodeIds)) ?? []);
  const moduleOwnershipFailures = (options.viewManifest || options.viewDetails) && analysis.moduleGraph.nodes.length + analysis.goModuleGraph.nodes.length > 0 && moduleDetailIds.size === 0
    ? ["no module detail projections"]
    : [];
  const runtimeReasons = [
    ...(analysis.coverage.publishable ? [] : ["runtime coverage gate failed"]),
    ...(analysis.census.rawBudgetExceeded ? ["raw source budget exceeded"] : []),
    ...(analysis.declarationCoverage.blockingViews.includes("runtime-overview") ? ["runtime declaration coverage failed"] : []),
    ...analysis.omissions.filter((omission) => omission.blocking && omission.affectedViews.includes("runtime-overview")).map((omission) => omission.detail),
    ...strict,
    ...overviewManifestReasons,
  ];
  const systemReasons = [
    ...unknownExternal,
    ...strict,
    ...overviewManifestReasons,
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
    ...moduleManifestReasons,
    ...moduleOwnershipFailures,
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
    ...flowManifestReasons,
    ...flowOwnershipFailures,
  ];
  if (analysis.ir.operations.length === 0) flowReasons.push("no protocol operations");
  const projection = options.projection ?? analysis.projection;
  const projectionReasons = projectionFailures(analysis, projection);
  const independenceReasons = options.independence && !options.independence.passed ? [options.independence.reason ?? "independent mutation suite failed"] : [];
  const goldEvaluation = options.gold ? evaluateCriticalGold(analysis, options.gold) : undefined;
  const goldReasons = goldEvaluation && !goldEvaluation.passed
    ? [`critical gold evaluation failed: ${[...goldEvaluation.missing, ...goldEvaluation.falsePositives, ...goldEvaluation.evidenceInvalid].join(", ")}`]
    : [];
  const manifestRoundtrip = options.viewManifest
    ? validateViewManifest(options.viewManifest, options.viewPages ?? [], analysis.evidence.records, analysis.ir, options.viewDetails)
    : undefined;
  const manifestReasons = manifestRoundtrip && !manifestRoundtrip.ok
    ? [`view projection reconciliation failed: ${[...manifestRoundtrip.missingFactIds, ...manifestRoundtrip.duplicateFactIds, ...manifestRoundtrip.danglingEvidenceIds].join(", ")}`]
    : [];
  const fullReasons = [
    ...runtimeReasons,
    ...systemReasons,
    ...moduleReasons,
    ...flowReasons,
    ...projectionReasons,
    ...manifestReasons,
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
