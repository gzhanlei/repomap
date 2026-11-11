import { z } from "zod";
import { createUnavailableAdapter, type LanguageAdapter } from "./project/adapter.js";
import { analyzeArchitectureFacts } from "./extract.js";
import type { ArchitectureSignalInventory } from "./signals.js";
import type { ArchitectureSource } from "./source.js";
import type { ArchitectureAnalysisOptions } from "./extract.js";

export const independenceCaseSchema = z.object({
  id: z.string().min(1),
  expected: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  blockedViews: z.array(z.string().min(1)),
  passed: z.boolean(),
  reason: z.string().min(1),
}).strict();
export type IndependenceCase = z.infer<typeof independenceCaseSchema>;

export const independenceResultSchema = z.object({
  passed: z.boolean(),
  cases: z.array(independenceCaseSchema),
  reason: z.string().min(1),
}).strict();
export type IndependenceResult = z.infer<typeof independenceResultSchema>;

function unavailableAdapters(): LanguageAdapter[] {
  return [
    createUnavailableAdapter("ast-typescript", ["typescript", "javascript"], "M5 mutation: semantic TypeScript extraction disabled"),
    createUnavailableAdapter("ast-go", ["go"], "M5 mutation: semantic Go extraction disabled"),
    createUnavailableAdapter("ast-python", ["python"], "M8 mutation: semantic Python extraction disabled"),
  ];
}

function caseResult(id: string, expected: number, retained: number, missing: number, blockedViews: string[], passed: boolean, reason: string): IndependenceCase {
  return independenceCaseSchema.parse({ id, expected, retained, missing, blockedViews, passed, reason });
}

export function runIndependenceMutations(
  input: Pick<ArchitectureSignalInventory, "revision" | "scope">,
  sources: ArchitectureSource[],
  options: ArchitectureAnalysisOptions & { baseline?: ReturnType<typeof analyzeArchitectureFacts> } = {},
): IndependenceResult {
  const baseline = options.baseline ?? analyzeArchitectureFacts(input, sources, options);
  const { baseline: _ignoredBaseline, ...analysisOptions } = options;
  const mutated = analyzeArchitectureFacts(input, sources, { ...analysisOptions, adapters: unavailableAdapters() });
  const semanticMissing = mutated.routeGraph.coverage.missing.length + mutated.moduleGraph.importDeclarations.missing.length + mutated.goModuleGraph.importDeclarations.missing.length + mutated.asyncGraph.coverage.missing.length;
  const cases = [
    caseResult(
      "independent-declaration-inventory",
      baseline.declarations.statistics.total,
      mutated.declarations.statistics.total,
      semanticMissing,
      ["module-architecture", "full-declared-scope"],
      baseline.declarations.statistics.total === mutated.declarations.statistics.total && semanticMissing > 0,
      "declaration inventory must survive semantic extractor removal",
    ),
    caseResult(
      "independent-module-import-denominator",
      baseline.moduleGraph.importDeclarations.expected + baseline.goModuleGraph.importDeclarations.expected,
      mutated.moduleGraph.importDeclarations.expected + mutated.goModuleGraph.importDeclarations.expected,
      mutated.moduleGraph.importDeclarations.missing.length + mutated.goModuleGraph.importDeclarations.missing.length,
      ["module-architecture", "full-declared-scope"],
      baseline.moduleGraph.importDeclarations.expected === mutated.moduleGraph.importDeclarations.expected
        && baseline.goModuleGraph.importDeclarations.expected === mutated.goModuleGraph.importDeclarations.expected
        && (baseline.moduleGraph.importDeclarations.expected + baseline.goModuleGraph.importDeclarations.expected === 0 || mutated.moduleGraph.importDeclarations.missing.length + mutated.goModuleGraph.importDeclarations.missing.length > 0),
      "module import denominator must not shrink with adapters disabled",
    ),
    caseResult(
      "independent-route-denominator",
      baseline.routeGraph.declarations.length,
      mutated.routeGraph.declarations.length,
      mutated.routeGraph.coverage.missing.length,
      mutated.routeGraph.gates.blockedViews,
      baseline.routeGraph.declarations.length === mutated.routeGraph.declarations.length && (baseline.routeGraph.declarations.length === 0 || mutated.routeGraph.coverage.missing.length > 0),
      "route declarations must survive route extractor removal",
    ),
    caseResult(
      "independent-async-denominator",
      baseline.asyncGraph.declarations.length,
      mutated.asyncGraph.declarations.length,
      mutated.asyncGraph.coverage.missing.length,
      mutated.asyncGraph.gates.blockedViews,
      baseline.asyncGraph.declarations.length === mutated.asyncGraph.declarations.length && (baseline.asyncGraph.declarations.length === 0 || mutated.asyncGraph.coverage.missing.length > 0),
      "async declarations must survive async extractor removal",
    ),
  ];
  return independenceResultSchema.parse({
    passed: cases.every((item) => item.passed),
    cases,
    reason: cases.every((item) => item.passed)
      ? "Independent declaration, import, route and async denominators survived adapter removal and reported missing semantic facts."
      : "An independent denominator changed with semantic extractors disabled or did not block coverage.",
  });
}
