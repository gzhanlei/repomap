import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { SourceCensus } from "../census.js";
import {
  astImportEvidenceRecord, evidenceRecordSchema, evidenceReferenceSchema,
  type EvidenceRecord, type EvidenceReference,
} from "../evidence-index.js";
import { irOmissionSchema, type IrOmission } from "../ir.js";
import { architectureViewSchema } from "../scope.js";
import { importResolutionSchema, type ImportRef, type ProjectPreparation } from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";
import { readTypeScriptResolutionRules } from "./typescript.js";

/**
 * PR #6 `ts-module-graph`. One source file is one module (ES module unit); the
 * graph does NOT expand functions or statements. Package ownership comes from
 * manifests / directory conventions in the census, and every edge points back
 * to a stable AST evidence ID in architecture.evidence.json.
 *
 * Cycles are preserved, external packages and unresolved imports are separate
 * explicit sets, and no edge is ever dropped to make a layout look acyclic.
 */

const tsconfigRuleSchema = z.object({
  path: z.string().min(1),
  root: z.string(),
  baseUrl: z.string().min(1),
  paths: z.record(z.string(), z.array(z.string())),
  references: z.array(z.string()),
}).strict();

const workspacePackageSchema = z.object({
  name: z.string().min(1),
  root: z.string(),
  manifestPath: z.string().min(1),
  main: z.string().min(1).optional(),
}).strict();

const resolutionRulesSchema = z.object({
  tsconfigs: z.array(tsconfigRuleSchema),
  workspacePackages: z.array(workspacePackageSchema),
  extensionCandidates: z.array(z.string()),
}).strict();

export const moduleNodeSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  packageId: z.string().min(1),
  group: z.string(),
  language: z.string().min(1),
  kind: z.enum(["source-module", "barrel", "entrypoint", "declaration-file"]),
  owner: z.string().min(1),
  ownerBasis: z.enum(["manifest", "directory-convention", "source-declaration"]),
  entrypoint: z.boolean(),
  exportedSymbolCount: z.number().int().nonnegative(),
  inDegree: z.number().int().nonnegative(),
  outDegree: z.number().int().nonnegative(),
}).strict();
export type ModuleNode = z.infer<typeof moduleNodeSchema>;

export const moduleEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  toKind: z.enum(["module", "external", "unresolved"]),
  kind: z.enum(["static", "dynamic", "re-export", "require"]),
  source: z.string().min(1),
  resolution: importResolutionSchema,
  path: z.string().min(1),
  line: z.number().int().positive(),
  crossPackage: z.boolean(),
  barrel: z.boolean(),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type ModuleEdge = z.infer<typeof moduleEdgeSchema>;

const externalPackageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
  referencedBy: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive(), kind: z.string().min(1) }).strict()),
}).strict();

const unresolvedImportSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  source: z.string().min(1),
  kind: z.string().min(1),
  reason: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
}).strict();

export const cycleSchema = z.object({
  id: z.string().min(1),
  nodes: z.array(z.string().min(1)),
  edges: z.array(z.string().min(1)),
  preservesSemantics: z.literal(true),
}).strict();
export type ModuleCycle = z.infer<typeof cycleSchema>;

/**
 * Independent denominator discovery. A line scanner declares WHERE import
 * syntax exists; it never produces a module edge. This is deliberately not the
 * AST extractor, so a mutation test can prove the coverage denominator does
 * not come from the extractor being evaluated.
 */
const importDeclarationSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
}).strict();

const importCoverageSchema = z.object({
  discovery: z.literal("independent-regex-line-scan"),
  expected: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  missing: z.array(importDeclarationSchema),
}).strict();

export function discoverImportDeclarations(snapshot: SourceSnapshot, modulePaths: string[]): z.infer<typeof importDeclarationSchema>[] {
  const declarations: z.infer<typeof importDeclarationSchema>[] = [];
  for (const path of modulePaths) {
    const raw = snapshot.rawText(path);
    if (raw === undefined) continue;
    raw.split("\n").forEach((line, index) => {
      const syntactic = /^\s*import\s/.test(line) || /^\s*export\s.*\bfrom\s/.test(line);
      const callSite = /\bimport\s*\(/.test(line) || /\brequire\s*\(/.test(line);
      if (!syntactic && !callSite) return;
      declarations.push(importDeclarationSchema.parse({ id: `import-decl:${path}:${index + 1}`, path, line: index + 1 }));
    });
  }
  return declarations.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`));
}

export const moduleGraphSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  snapshotId: z.string().min(1),
  granularity: z.literal("source-module"),
  nodes: z.array(moduleNodeSchema),
  edges: z.array(moduleEdgeSchema),
  externalPackages: z.array(externalPackageSchema),
  unresolvedImports: z.array(unresolvedImportSchema),
  cycles: z.array(cycleSchema),
  importDeclarations: importCoverageSchema,
  resolutionRules: resolutionRulesSchema,
  omissions: z.array(irOmissionSchema),
  gates: z.object({
    blockedViews: z.array(architectureViewSchema),
    runtimeOverviewUnaffected: z.literal(true),
    reasons: z.array(z.string()),
  }).strict(),
  statistics: z.object({
    modules: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    internalEdges: z.number().int().nonnegative(),
    crossPackageEdges: z.number().int().nonnegative(),
    barrelEdges: z.number().int().nonnegative(),
    aliasEdges: z.number().int().nonnegative(),
    workspaceEdges: z.number().int().nonnegative(),
    projectReferenceEdges: z.number().int().nonnegative(),
    externalPackages: z.number().int().nonnegative(),
    unresolvedImports: z.number().int().nonnegative(),
    cycles: z.number().int().nonnegative(),
    evidenceRecords: z.number().int().nonnegative(),
    parsedUnits: z.number().int().nonnegative(),
  }).strict(),
  evidenceRecords: z.array(evidenceRecordSchema),
}).strict();
export type ModuleGraph = z.infer<typeof moduleGraphSchema>;

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function moduleId(packageId: string, path: string) {
  return `module:${packageId}:${path}`;
}

/** Iterative Kosaraju: large monorepos must not depend on JS recursion depth. Shared by the TS and Go package graphs. */
export function findCycles(nodeIds: string[], internal: Pick<ModuleEdge, "id" | "from" | "to">[]): ModuleCycle[] {
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const reverse = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of internal) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    const stack: [string, number][] = [[start, 0]];
    visited.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = adjacency.get(frame[0]) ?? [];
      if (frame[1] < neighbours.length) {
        const next = neighbours[frame[1]];
        frame[1] += 1;
        if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
      } else {
        order.push(frame[0]);
        stack.pop();
      }
    }
  }
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const start of [...order].reverse()) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const node = stack.pop() as string;
      component.push(node);
      for (const previous of reverse.get(node) ?? []) {
        if (!assigned.has(previous)) { assigned.add(previous); stack.push(previous); }
      }
    }
    components.push(component);
  }
  return components
    .filter((component) => component.length > 1 || (adjacency.get(component[0]) ?? []).includes(component[0]))
    .map((component) => {
      const members = new Set(component);
      const nodes = [...component].sort();
      return cycleSchema.parse({
        id: `cycle:${shortHash(nodes.join("|"))}`,
        nodes,
        edges: internal.filter((edge) => members.has(edge.from) && members.has(edge.to)).map((edge) => edge.id).sort(),
        preservesSemantics: true,
      });
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface BuildModuleGraphInput {
  revision: string;
  snapshot: SourceSnapshot;
  census: SourceCensus;
  project: ProjectPreparation;
}

export function buildModuleGraph(input: BuildModuleGraphInput): ModuleGraph {
  const { snapshot, census, project } = input;
  const rules = resolutionRulesSchema.parse(readTypeScriptResolutionRules(snapshot));
  const packageManifests = new Set(census.packages.filter((entry) => entry.manifests.length > 0).map((entry) => entry.id));
  const preparedUnits = project.units.filter((unit) => unit.status === "prepared" && unit.adapterId === "ast-typescript");
  const modulePaths = [...new Set(preparedUnits.flatMap((unit) => unit.files))].sort();
  const packageOf = new Map(snapshot.files.map((file) => [file.path, file.packageId]));
  const languageOf = new Map(snapshot.files.map((file) => [file.path, file.language]));
  const entrypoints = new Set(project.entrypoints.map((entry) => entry.path));
  const exportedCount = new Map<string, number>();
  for (const symbol of project.symbols) {
    if (!symbol.exported) continue;
    exportedCount.set(symbol.path, (exportedCount.get(symbol.path) ?? 0) + 1);
  }

  const nodes: ModuleNode[] = modulePaths.map((path) => {
    const packageId = packageOf.get(path) ?? "package:root";
    const isDeclaration = /\.d\.(?:ts|mts|cts)$/i.test(path);
    const isBarrel = /(?:^|\/)index\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path);
    const kind = isDeclaration ? "declaration-file" : isBarrel ? "barrel" : entrypoints.has(path) ? "entrypoint" : "source-module";
    return moduleNodeSchema.parse({
      id: moduleId(packageId, path),
      path,
      packageId,
      group: `${packageId}:${posix.dirname(path)}`,
      language: languageOf.get(path) ?? "unknown",
      kind,
      owner: packageId,
      ownerBasis: isDeclaration ? "source-declaration" : packageManifests.has(packageId) ? "manifest" : "directory-convention",
      entrypoint: entrypoints.has(path),
      exportedSymbolCount: exportedCount.get(path) ?? 0,
      inDegree: 0,
      outDegree: 0,
    });
  });
  const byPath = new Map(nodes.map((node) => [node.path, node]));

  const evidenceRecords: EvidenceRecord[] = [];
  const edges: ModuleEdge[] = [];
  const external = new Map<string, z.infer<typeof externalPackageSchema>>();
  const unresolved: z.infer<typeof unresolvedImportSchema>[] = [];
  const omissions: IrOmission[] = [];

  const imports = [...project.imports].sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`));
  for (const item of imports) {
    const from = byPath.get(item.path);
    if (!from) continue; // imports from units with no shipped adapter are gated, not faked
    const record = astImportEvidenceRecord({ path: item.path, line: item.line, kind: item.kind });
    evidenceRecords.push(record);
    const edgeId = `module-edge:${shortHash(`${item.path}|${item.line}|${item.source}|${item.kind}`)}`;
    let to: string;
    let toKind: ModuleEdge["toKind"];
    let crossPackage = false;
    if (item.resolvedPath && byPath.has(item.resolvedPath)) {
      const target = byPath.get(item.resolvedPath) as ModuleNode;
      to = target.id;
      toKind = "module";
      crossPackage = from.packageId !== target.packageId;
      target.inDegree += 1;
    } else if (item.resolution === "unresolved" && /^\.{1,2}\//.test(item.source)) {
      to = `unresolved:${shortHash(`${item.path}:${item.line}:${item.source}`)}`;
      toKind = "unresolved";
      const reason = item.unresolvedReason ?? "relative-import-not-resolved-in-snapshot";
      unresolved.push(unresolvedImportSchema.parse({
        id: to, path: item.path, line: item.line, source: item.source, kind: item.kind,
        reason, evidenceIds: [record.id],
      }));
      omissions.push(irOmissionSchema.parse({
        id: `omission:module-graph:${edgeId}`,
        owner: edgeId,
        reason: "unresolved-import",
        detail: `${item.path}:${item.line} imports '${item.source}' but no module in the snapshot resolves it (${reason})`,
        declarationIds: [], evidenceIds: [record.id],
        affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
      }));
    } else {
      const name = item.source.startsWith("@") ? item.source.split("/").slice(0, 2).join("/") : item.source.split("/")[0];
      to = `external:${name}`;
      toKind = "external";
      const entry = external.get(name) ?? externalPackageSchema.parse({
        id: to, name,
        reason: item.unresolvedReason ?? "external-package-not-in-snapshot",
        referencedBy: [],
      });
      entry.referencedBy.push({ path: item.path, line: item.line, kind: item.kind });
      external.set(name, entry);
    }
    from.outDegree += 1;
    edges.push(moduleEdgeSchema.parse({
      id: edgeId,
      from: from.id,
      to,
      toKind,
      kind: item.kind,
      source: item.source,
      resolution: toKind === "module" ? (item.resolution ?? "relative") : toKind === "external" ? "external" : "unresolved",
      path: item.path,
      line: item.line,
      crossPackage,
      barrel: item.barrel === true,
      evidenceIds: [record.id],
    }));
  }

  if (preparedUnits.length === 0) {
    omissions.push(irOmissionSchema.parse({
      id: "omission:module-graph:parser-unavailable",
      owner: "module-graph",
      reason: "parser-unavailable",
      detail: "No prepared TypeScript/JavaScript unit is available, so no module graph could be built",
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
  }
  for (const error of project.parseErrors) {
    omissions.push(irOmissionSchema.parse({
      id: `omission:module-graph:parse-error:${shortHash(`${error.path}:${error.line}:${error.message}`)}`,
      owner: error.path,
      reason: "parse-error",
      detail: `${error.path}:${error.line} ${error.message}`,
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
  }

  const internalEdges = edges.filter((edge) => edge.toKind === "module");
  const cycles = findCycles(nodes.map((node) => node.id), internalEdges);
  // Independent denominator: every syntactically declared import must have an
  // AST edge. A disabled extractor therefore produces missing declarations,
  // never a silently complete-looking graph.
  const declarations = discoverImportDeclarations(snapshot, modulePaths);
  const observedKeys = new Set(edges.map((edge) => `${edge.path}:${edge.line}`));
  const missing = declarations.filter((declaration) => !observedKeys.has(`${declaration.path}:${declaration.line}`));
  const importDeclarations = importCoverageSchema.parse({
    discovery: "independent-regex-line-scan",
    expected: declarations.length,
    observed: edges.length,
    missing,
  });
  const reasons: string[] = [];
  if (missing.length > 0) {
    omissions.push(irOmissionSchema.parse({
      id: "omission:module-graph:independent-import-coverage",
      owner: "module-graph",
      reason: "unsupported-syntax",
      detail: `${missing.length} independently discovered import declaration(s) have no AST module edge; the extractor may be disabled or the syntax unsupported`,
      declarationIds: missing.map((declaration) => declaration.id), evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
    reasons.push(`${missing.length} independently discovered import declaration(s) lack an AST edge`);
  }
  if (unresolved.length > 0) reasons.push(`${unresolved.length} unresolved relative import(s) block the module view`);
  if (project.parseErrors.length > 0) reasons.push(`${project.parseErrors.length} syntax diagnostic(s) block the module view`);
  if (preparedUnits.length === 0) reasons.push("no prepared TypeScript/JavaScript unit");
  // PR #7: Go is no longer an unshipped capability, but its package graph has
  // a different granularity and lives in a separate artifact. This is a note,
  // not a blocking reason for the TypeScript source-module graph.
  const hasGoSources = census.files.some((file) => file.language === "go" && file.role === "source");
  const notes = hasGoSources ? ["Go package graph is delivered separately in architecture.go-module-graph.json"] : [];
  const gateReasons = [...reasons, ...notes];
  const blocked = reasons.length > 0;

  return moduleGraphSchema.parse({
    version: 1,
    revision: input.revision,
    snapshotId: snapshot.snapshotId,
    granularity: "source-module",
    nodes,
    edges: edges.sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`)),
    externalPackages: [...external.values()].map((entry) => ({ ...entry, referencedBy: entry.referencedBy.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)) })).sort((a, b) => a.name.localeCompare(b.name)),
    unresolvedImports: unresolved.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)),
    cycles,
    importDeclarations,
    resolutionRules: rules,
    omissions: omissions.sort((a, b) => a.id.localeCompare(b.id)),
    gates: {
      blockedViews: blocked ? ["module-architecture", "full-declared-scope"] : [],
      runtimeOverviewUnaffected: true,
      reasons: gateReasons.length > 0 ? gateReasons : ["TypeScript/JavaScript module graph built; the module-architecture view gate itself is still a later PR"],
    },
    statistics: {
      modules: nodes.length,
      edges: edges.length,
      internalEdges: internalEdges.length,
      crossPackageEdges: edges.filter((edge) => edge.crossPackage).length,
      barrelEdges: edges.filter((edge) => edge.barrel).length,
      aliasEdges: edges.filter((edge) => edge.resolution === "alias").length,
      workspaceEdges: edges.filter((edge) => edge.resolution === "workspace-package").length,
      projectReferenceEdges: edges.filter((edge) => edge.resolution === "project-reference").length,
      externalPackages: external.size,
      unresolvedImports: unresolved.length,
      cycles: cycles.length,
      evidenceRecords: evidenceRecords.length,
      parsedUnits: preparedUnits.length,
    },
    evidenceRecords: [...new Map(evidenceRecords.map((record) => [record.id, record])).values()].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** One reference per module edge, so the projection manifest reconciles AST evidence too. */
export function moduleGraphEvidenceReferences(graph: ModuleGraph): EvidenceReference[] {
  return graph.edges.map((edge) => evidenceReferenceSchema.parse({
    ownerType: "module-edge",
    ownerId: edge.id,
    evidenceIds: edge.evidenceIds,
    renderedEvidenceIds: edge.evidenceIds.slice(0, 3),
    remainingEvidenceIds: edge.evidenceIds.slice(3),
    selectionReason: "AST import statement; the complete set is retained in evidenceIds and in the evidence index",
  }));
}

export function viewsBlockedByModuleGraph(graph: ModuleGraph) {
  return graph.gates.blockedViews;
}
