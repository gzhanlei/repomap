#!/usr/bin/env node
// M7 targeted Gold evaluation: match a human-authored gold set against the
// written artifacts of one fixed-SHA analysis run. Read-only; exits non-zero
// when recall, precision or evidence checks fail. Omissions are reported but
// never folded into the verdict.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateCorpusGold, corpusGoldSetSchema, type CorpusGoldArtifacts } from "../src/core/architecture/corpus-gold.js";

function usage(): never {
  console.error("usage: tsx scripts/evaluate-gold.ts --out <analysis-output-dir> --gold <gold-set.json>");
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outDir = argValue("--out");
const goldPath = argValue("--gold");
if (!outDir || !goldPath) usage();

const readJson = (file: string) => JSON.parse(readFileSync(resolve(outDir, file), "utf8"));

const ir = readJson("architecture.ir.json");
const moduleGraph = readJson("architecture.module-graph.json");
const routeGraph = readJson("architecture.route-graph.json");
const asyncGraph = readJson("architecture.async-graph.json");
const evidence = readJson("architecture.evidence.json");

const evidencePathsById = new Map<string, string>(
  evidence.records.map((record: { id: string; path: string }) => [record.id, record.path]),
);

const artifacts: CorpusGoldArtifacts = {
  revision: ir.revision,
  modules: (moduleGraph.nodes as Array<Record<string, unknown>>).map((node) => ({
    id: node.id as string,
    path: node.path as string,
    language: node.language as string | undefined,
    evidenceIds: (node.evidenceIds as string[] | undefined) ?? [],
  })),
  moduleEdges: (moduleGraph.edges as Array<Record<string, unknown>>).map((edge) => ({
    id: edge.id as string,
    from: edge.from as string,
    to: edge.to as string,
    toKind: edge.toKind as string,
    kind: edge.kind as string,
    path: edge.path as string,
    line: edge.line as number | undefined,
    evidenceIds: edge.evidenceIds as string[],
  })),
  cycles: (moduleGraph.cycles as Array<{ nodes: string[] }>).map((cycle) => ({
    memberPaths: cycle.nodes.map((nodeId) => {
      const node = (moduleGraph.nodes as Array<{ id: string; path: string }>).find((item) => item.id === nodeId);
      if (!node) throw new Error(`Cycle references unknown module node: ${nodeId}`);
      return node.path;
    }),
  })),
  routes: routeGraph.routes.map((route: Record<string, unknown>) => ({
    id: route.id as string,
    method: route.method as string,
    path: route.path as string,
    sourcePath: route.sourcePath as string,
    line: route.line as number | undefined,
    evidenceIds: route.evidenceIds as string[],
  })),
  routeHandlers: Object.values(routeGraph.handlers as Record<string, Record<string, unknown>>).map((handler) => ({
    id: handler.id as string,
    sourcePath: handler.sourcePath as string,
    line: handler.line as number | undefined,
    evidenceIds: handler.evidenceIds as string[],
  })),
  routeEdges: routeGraph.edges,
  sqlOperations: ir.operations.filter((operation: Record<string, unknown>) => operation.kind === "sql").map((operation: Record<string, unknown>) => ({
    id: operation.id as string,
    action: operation.action as string,
    callSite: operation.callSite as string,
    driver: operation.driver as string | undefined,
    evidenceIds: operation.evidenceIds as string[],
  })),
  asyncOperations: asyncGraph.operations.map((operation: Record<string, unknown>) => ({
    id: operation.id as string,
    action: operation.action as string,
    callSite: operation.callSite as string,
    topic: operation.topic as string | undefined,
    evidenceIds: operation.evidenceIds as string[],
  })),
  declarations: ir.declarations.map((declaration: Record<string, unknown>) => ({
    declarationId: declaration.declarationId as string,
    sourcePath: declaration.sourcePath as string,
    detail: declaration.detail as string,
    evidenceIds: declaration.evidenceIds as string[],
  })),
  evidencePathsById,
  omissions: {
    routeGraph: Array.isArray(routeGraph.omissions) ? routeGraph.omissions.length : 0,
    asyncGraph: Array.isArray(asyncGraph.omissions) ? asyncGraph.omissions.length : 0,
    ir: Array.isArray(ir.omissions) ? ir.omissions.length : 0,
  },
};

const gold = corpusGoldSetSchema.parse(JSON.parse(readFileSync(resolve(goldPath), "utf8")));
const evaluation = evaluateCorpusGold(artifacts, gold);
console.log(JSON.stringify(evaluation, null, 2));
process.exit(evaluation.passed ? 0 : 1);
