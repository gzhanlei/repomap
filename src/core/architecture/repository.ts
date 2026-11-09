import { analyzeArchitectureFacts, type ArchitectureAnalysisOptions } from "./extract.js";
import type { ArchitectureCoverage } from "./coverage.js";
import type { ArchitectureRepositorySourceReceipt, ArchitectureSource } from "./source.js";

export interface RepositoryArchitectureInput extends ArchitectureAnalysisOptions {
  revision: string;
  sources: ArchitectureSource[];
  sourceReceipt: ArchitectureRepositorySourceReceipt;
}

export function analyzeRepositoryArchitecture(input: RepositoryArchitectureInput) {
  if (input.sourceReceipt.scope !== "repository") throw new Error("Architecture source scope must be repository");
  if (input.sourceReceipt.files !== input.sources.length) throw new Error("Architecture source receipt does not match the complete source inventory");
  return {
    ...analyzeArchitectureFacts({ revision: input.revision, scope: "repository" }, input.sources, {
      inventory: input.inventory,
      userExclusions: input.userExclusions,
      include: input.include,
      exclude: input.exclude,
      requestedViews: input.requestedViews,
      strictExternalHosts: input.strictExternalHosts,
      buildContext: input.buildContext,
      rawBudgets: input.rawBudgets,
    }),
    sourceReceipt: input.sourceReceipt,
  };
}

export function assertArchitecturePublishable(coverage: ArchitectureCoverage) {
  if (coverage.publishable) return;
  const problems = [
    ...coverage.unclassifiedCriticalSignals.map((signal) => `missing signal ${signal.id}`),
    ...coverage.unsupportedNodes.map((id) => `unsupported node ${id}`),
    ...coverage.unsupportedEdges.map((id) => `unsupported edge ${id}`),
    ...coverage.unreachableRuntimeUnits.map((id) => `unreachable runtime ${id}`),
    ...coverage.blockingOmissions.map((omission) => `omission ${omission.signalId}: ${omission.detail}`),
  ];
  throw new Error(`Architecture coverage is not publishable: ${problems.join("; ") || "empty architecture or missing entry roots"}`);
}
