import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { SourceCensus } from "../census.js";
import {
  astGoImportEvidenceRecord, evidenceRecordSchema, evidenceReferenceSchema,
  type EvidenceRecord, type EvidenceReference,
} from "../evidence-index.js";
import { irOmissionSchema, type IrOmission } from "../ir.js";
import { architectureViewSchema } from "../scope.js";
import { importResolutionSchema, type ProjectPreparation } from "./adapter.js";
import { goExcludedFileSchema, goModuleSchema, goWorkspaceSchema, goFileSelection, analyzeGoSnapshot, type GoSourceFile } from "./go.js";
import { cycleSchema, findCycles, type ModuleCycle } from "./module-graph.js";
import type { SourceSnapshot } from "./snapshot.js";

/**
 * PR #7 `go-module-graph`: a **package-granularity** graph (plan §8.1), kept
 * in its own artifact because it is deliberately not a source-module graph.
 *
 * Resolution is snapshot-only: go.mod module paths, go.work members and local
 * replace directives. Standard-library and external modules are explicit sets,
 * never "unresolved". Internal specifiers that SHOULD resolve in the snapshot
 * but do not become blocking omissions. Cycles are preserved.
 *
 * The import denominator is an independent line scan over build-context
 * selected files; it does not call the AST extractor, so a mutation test can
 * disable extraction without making the denominator disappear.
 */

export const goModuleNodeSchema = z.object({
  id: z.string().min(1),
  importPath: z.string().min(1),
  dir: z.string().min(1),
  packageName: z.string().min(1),
  modulePath: z.string().min(1),
  kind: z.enum(["main-package", "library-package"]),
  owner: z.string().min(1),
  ownerBasis: z.enum(["go.mod", "go.work", "directory-convention"]),
  files: z.array(z.string().min(1)),
  entrypoint: z.boolean(),
  exportedSymbolCount: z.number().int().nonnegative(),
  callExpressions: z.number().int().nonnegative(),
  inDegree: z.number().int().nonnegative(),
  outDegree: z.number().int().nonnegative(),
}).strict();
export type GoModuleNode = z.infer<typeof goModuleNodeSchema>;

export const goModuleEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  toKind: z.enum(["package", "standard-library", "external", "unresolved"]),
  source: z.string().min(1),
  form: z.enum(["normal", "blank", "dot"]),
  alias: z.string().min(1).optional(),
  resolution: importResolutionSchema,
  path: z.string().min(1),
  line: z.number().int().positive(),
  crossModule: z.boolean(),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type GoModuleEdge = z.infer<typeof goModuleEdgeSchema>;

const referencedBySchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  form: z.string().min(1),
}).strict();

const dependencySetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
  referencedBy: z.array(referencedBySchema),
}).strict();

const goUnresolvedImportSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  source: z.string().min(1),
  reason: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
}).strict();

const goImportDeclarationSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
}).strict();

export const goModuleGraphSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  snapshotId: z.string().min(1),
  granularity: z.literal("go-package"),
  buildContext: z.object({
    goos: z.string().min(1),
    goarch: z.string().min(1),
    buildTags: z.array(z.string()),
  }).strict(),
  parser: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    runtime: z.string().min(1),
    status: z.enum(["available", "unavailable"]),
    detail: z.string().min(1),
  }).strict(),
  modules: z.array(goModuleSchema),
  workspaces: z.array(goWorkspaceSchema),
  moduleErrors: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive(), message: z.string().min(1) }).strict()),
  nodes: z.array(goModuleNodeSchema),
  edges: z.array(goModuleEdgeSchema),
  cycles: z.array(cycleSchema),
  standardPackages: z.array(dependencySetSchema),
  externalModules: z.array(dependencySetSchema),
  unresolvedImports: z.array(goUnresolvedImportSchema),
  excludedFiles: z.array(goExcludedFileSchema),
  importDeclarations: z.object({
    discovery: z.literal("independent-go-import-line-scan"),
    expected: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    missing: z.array(goImportDeclarationSchema),
  }).strict(),
  resolutionRules: z.object({
    moduleRoots: z.array(z.object({ modulePath: z.string().min(1), root: z.string(), workspaceMember: z.boolean() }).strict()),
    localReplaces: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
    workspaceUses: z.array(z.string().min(1)),
    standardLibraryRule: z.literal("first-path-segment-without-dot"),
  }).strict(),
  omissions: z.array(irOmissionSchema),
  gates: z.object({
    blockedViews: z.array(architectureViewSchema),
    runtimeOverviewUnaffected: z.literal(true),
    reasons: z.array(z.string()),
  }).strict(),
  statistics: z.object({
    packages: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    internalEdges: z.number().int().nonnegative(),
    crossModuleEdges: z.number().int().nonnegative(),
    standardLibraryEdges: z.number().int().nonnegative(),
    externalEdges: z.number().int().nonnegative(),
    unresolvedImports: z.number().int().nonnegative(),
    cycles: z.number().int().nonnegative(),
    excludedFiles: z.number().int().nonnegative(),
    parsedFiles: z.number().int().nonnegative(),
    callExpressions: z.number().int().nonnegative(),
    modules: z.number().int().nonnegative(),
    workspaces: z.number().int().nonnegative(),
    evidenceRecords: z.number().int().nonnegative(),
  }).strict(),
  evidenceRecords: z.array(evidenceRecordSchema),
}).strict();
export type GoModuleGraph = z.infer<typeof goModuleGraphSchema>;

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function groupKey(file: GoSourceFile) {
  return `${file.dir}#${file.packageName}`;
}

function moduleNameOf(source: string) {
  const parts = source.split("/");
  return parts.length >= 3 ? parts.slice(0, 3).join("/") : source;
}

/**
 * Independent denominator. It re-derives the build-context selected file set
 * itself (no AST, no project.imports), then line-scans import declarations.
 * A disabled AST extractor therefore changes `missing`, never `expected`.
 */
export function discoverGoImportDeclarations(snapshot: SourceSnapshot, buildContext: ProjectPreparation["buildContext"]) {
  const declarations: z.infer<typeof goImportDeclarationSchema>[] = [];
  for (const file of snapshot.files) {
    if (file.language !== "go" || file.role !== "source") continue;
    const raw = snapshot.rawText(file.path);
    if (raw === undefined) continue;
    if (!goFileSelection(file.path, raw, buildContext).included) continue;
    let inImportBlock = false;
    raw.split("\n").forEach((line, index) => {
      if (/^\s*import\s*\(/.test(line)) { inImportBlock = true; return; }
      if (inImportBlock) {
        if (/^\s*\)/.test(line)) { inImportBlock = false; return; }
        if (/^\s*(?:[A-Za-z_][\w]*|\.|_)\s+[`"']/.test(line) || /^\s*[`"']/.test(line)) {
          declarations.push(goImportDeclarationSchema.parse({ id: `go-import-decl:${file.path}:${index + 1}`, path: file.path, line: index + 1 }));
        }
        return;
      }
      if (/^\s*import\s+(?:[A-Za-z_][\w]*|\.|_)?\s*[`"']/.test(line)) {
        declarations.push(goImportDeclarationSchema.parse({ id: `go-import-decl:${file.path}:${index + 1}`, path: file.path, line: index + 1 }));
      }
    });
  }
  return declarations.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`));
}

export interface BuildGoModuleGraphInput {
  revision: string;
  snapshot: SourceSnapshot;
  census: SourceCensus;
  project: ProjectPreparation;
}

export function buildGoModuleGraph(input: BuildGoModuleGraphInput): GoModuleGraph {
  const { snapshot, census, project } = input;
  const analysis = analyzeGoSnapshot(snapshot, project.buildContext);
  const preparedUnits = project.units.filter((unit) => unit.status === "prepared" && unit.adapterId === "ast-go");
  const includedPaths = new Set(preparedUnits.flatMap((unit) => unit.files));
  const includedFiles = analysis.files.filter((file) => includedPaths.has(file.path));
  const groups = new Map<string, GoSourceFile[]>();
  for (const file of includedFiles) groups.set(groupKey(file), [...(groups.get(groupKey(file)) ?? []), file]);
  const modulesByPathLength = [...analysis.modules].sort((a, b) => b.modulePath.length - a.modulePath.length);
  const moduleForDir = (dir: string) => analysis.modules.find((module) => {
    const root = module.root === "." ? "." : module.root.replace(/\/$/, "");
    return root === "." || dir === root || dir.startsWith(`${root}/`);
  });
  const entrypointPaths = new Set(project.entrypoints.filter((entry) => entry.kind === "go-main").map((entry) => entry.path));

  const nodes: GoModuleNode[] = [...groups.entries()].map(([key, files]) => {
    const first = files[0];
    const module = moduleForDir(first.dir);
    const root = module?.root ?? ".";
    const relative = root === "." ? first.dir : posix.relative(root, first.dir);
    const importPath = module ? (relative === "." || relative === "" ? module.modulePath : `${module.modulePath}/${relative}`) : first.dir;
    const ownerBasis = !module ? "directory-convention" : module.workspaceMember && analysis.workspaces.length > 0 ? "go.work" : "go.mod";
    return goModuleNodeSchema.parse({
      id: `go-package:${first.dir}:${first.packageName}`,
      importPath,
      dir: first.dir,
      packageName: first.packageName,
      modulePath: module?.modulePath ?? "(no-go.mod)",
      kind: first.packageName === "main" ? "main-package" : "library-package",
      owner: first.packageId,
      ownerBasis,
      files: files.map((file) => file.path).sort(),
      entrypoint: files.some((file) => entrypointPaths.has(file.path)),
      exportedSymbolCount: files.reduce((total, file) => total + file.parsed.symbols.filter((symbol) => symbol.exported).length, 0),
      callExpressions: files.reduce((total, file) => total + file.parsed.callExpressions, 0),
      inDegree: 0,
      outDegree: 0,
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const byFilePath = new Map(includedFiles.map((file) => [file.path, `go-package:${file.dir}:${file.packageName}`]));
  const byDir = new Map(nodes.map((node) => [node.dir, node]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const evidenceRecords: EvidenceRecord[] = [];
  const edges: GoModuleEdge[] = [];
  const standard = new Map<string, z.infer<typeof dependencySetSchema>>();
  const external = new Map<string, z.infer<typeof dependencySetSchema>>();
  const unresolved: z.infer<typeof goUnresolvedImportSchema>[] = [];
  const omissions: IrOmission[] = [];
  const blockingReasons: string[] = [];

  const goImports = project.imports
    .filter((item) => item.importForm !== undefined && includedPaths.has(item.path))
    .sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`));

  for (const item of goImports) {
    const fromId = byFilePath.get(item.path);
    if (!fromId) continue;
    const from = nodeById.get(fromId);
    if (!from) continue;
    const form = item.importForm ?? "normal";
    const record = astGoImportEvidenceRecord({ path: item.path, line: item.line, form });
    evidenceRecords.push(record);
    const edgeId = `go-edge:${shortHash(`${item.path}|${item.line}|${item.source}|${form}`)}`;
    const reference = { path: item.path, line: item.line, form };
    let to: string;
    let toKind: GoModuleEdge["toKind"];
    let crossModule = false;

    if (item.resolvedPath && byDir.has(item.resolvedPath)) {
      const target = byDir.get(item.resolvedPath) as GoModuleNode;
      to = target.id;
      toKind = "package";
      crossModule = target.modulePath !== from.modulePath;
      target.inDegree += 1;
    } else if (item.resolution === "standard-library") {
      to = `stdlib:${item.source}`;
      toKind = "standard-library";
      const entry = standard.get(item.source) ?? dependencySetSchema.parse({ id: to, name: item.source, reason: item.unresolvedReason ?? "standard-library-package-not-in-snapshot", referencedBy: [] });
      entry.referencedBy.push(reference);
      standard.set(item.source, entry);
    } else if (item.resolution === "unresolved") {
      to = `unresolved:${shortHash(`${item.path}:${item.line}:${item.source}`)}`;
      toKind = "unresolved";
      const reason = item.unresolvedReason ?? "go-import-not-resolved-in-snapshot";
      unresolved.push(goUnresolvedImportSchema.parse({ id: to, path: item.path, line: item.line, source: item.source, reason, evidenceIds: [record.id] }));
      omissions.push(irOmissionSchema.parse({
        id: `omission:go-module-graph:${edgeId}`,
        owner: edgeId,
        reason: "unresolved-import",
        detail: `${item.path}:${item.line} imports '${item.source}' but the Go package is missing from the snapshot (${reason})`,
        declarationIds: [], evidenceIds: [record.id],
        affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
      }));
    } else {
      const name = moduleNameOf(item.source);
      to = `external:${name}`;
      toKind = "external";
      const entry = external.get(name) ?? dependencySetSchema.parse({ id: to, name, reason: item.unresolvedReason ?? "external-module-not-in-snapshot", referencedBy: [] });
      entry.referencedBy.push(reference);
      external.set(name, entry);
    }
    from.outDegree += 1;
    edges.push(goModuleEdgeSchema.parse({
      id: edgeId,
      from: fromId,
      to,
      toKind,
      source: item.source,
      form,
      ...(item.alias ? { alias: item.alias } : {}),
      resolution: item.resolution ?? "unresolved",
      path: item.path,
      line: item.line,
      crossModule,
      evidenceIds: [record.id],
    }));
  }

  const goSourceInCensus = census.files.some((file) => file.language === "go" && file.role === "source");
  if (goSourceInCensus && analysis.parser.status === "unavailable") {
    omissions.push(irOmissionSchema.parse({
      id: "omission:go-module-graph:parser-unavailable",
      owner: "go-module-graph",
      reason: "parser-unavailable",
      detail: `The fixed Go WASM grammar is unavailable, so no Go package graph could be built: ${analysis.parser.detail}`,
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
    blockingReasons.push("Go WASM grammar unavailable");
  }
  if (goSourceInCensus && analysis.parser.status === "available" && preparedUnits.length === 0 && analysis.files.length > 0) {
    omissions.push(irOmissionSchema.parse({
      id: "omission:go-module-graph:no-prepared-unit",
      owner: "go-module-graph",
      reason: "parser-unavailable",
      detail: "No prepared Go project unit is available (the Go adapter may be injected as unavailable), so no Go package graph could be built",
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
    blockingReasons.push("no prepared Go project unit");
  }
  for (const error of analysis.moduleErrors) {
    omissions.push(irOmissionSchema.parse({
      id: `omission:go-module-graph:go-mod:${shortHash(`${error.path}:${error.line}:${error.message}`)}`,
      owner: error.path,
      reason: "unsupported-syntax",
      detail: `${error.path}:${error.line} ${error.message}`,
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
  }
  if (analysis.moduleErrors.length > 0) blockingReasons.push(`${analysis.moduleErrors.length} go.mod/go.work directive(s) are not supported`);
  const goParseErrors = project.parseErrors.filter((error) => includedPaths.has(error.path));
  for (const error of goParseErrors) {
    omissions.push(irOmissionSchema.parse({
      id: `omission:go-module-graph:parse-error:${shortHash(`${error.path}:${error.line}:${error.message}`)}`,
      owner: error.path,
      reason: "parse-error",
      detail: `${error.path}:${error.line} ${error.message}`,
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
  }
  if (goParseErrors.length > 0) blockingReasons.push(`${goParseErrors.length} Go syntax diagnostic(s) block the module view`);
  if (unresolved.length > 0) blockingReasons.push(`${unresolved.length} unresolved internal Go import(s) block the module view`);

  const declarations = discoverGoImportDeclarations(snapshot, project.buildContext);
  const observedKeys = new Set(edges.map((edge) => `${edge.path}:${edge.line}`));
  const missing = declarations.filter((declaration) => !observedKeys.has(`${declaration.path}:${declaration.line}`));
  if (missing.length > 0) {
    omissions.push(irOmissionSchema.parse({
      id: "omission:go-module-graph:independent-import-coverage",
      owner: "go-module-graph",
      reason: "unsupported-syntax",
      detail: `${missing.length} independently discovered Go import declaration(s) have no AST package edge; the extractor may be disabled or the syntax unsupported`,
      declarationIds: missing.map((declaration) => declaration.id), evidenceIds: [],
      affectedViews: ["module-architecture", "full-declared-scope"], blocking: true,
    }));
    blockingReasons.push(`${missing.length} independently discovered Go import declaration(s) lack an AST edge`);
  }

  const internalEdges = edges.filter((edge) => edge.toKind === "package");
  const cycles: ModuleCycle[] = findCycles(nodes.map((node) => node.id), internalEdges);
  const notes: string[] = [];
  if (analysis.excludedFiles.length > 0) notes.push(`${analysis.excludedFiles.length} Go file(s) excluded by the explicit build context; dispositions are enumerated in excludedFiles`);
  if (nodes.length === 0 && goSourceInCensus && analysis.parser.status === "available") notes.push("No Go package was selected by the declared build context");
  if (blockingReasons.length === 0) notes.push("Go package graph built; the module-architecture view gate itself is still a later PR");

  const dedupedEvidence = [...new Map(evidenceRecords.map((record) => [record.id, record])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return goModuleGraphSchema.parse({
    version: 1,
    revision: input.revision,
    snapshotId: snapshot.snapshotId,
    granularity: "go-package",
    buildContext: {
      goos: project.buildContext.goos,
      goarch: project.buildContext.goarch,
      buildTags: project.buildContext.buildTags,
    },
    parser: analysis.parser,
    modules: analysis.modules,
    workspaces: analysis.workspaces,
    moduleErrors: analysis.moduleErrors,
    nodes,
    edges: edges.sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`)),
    cycles,
    standardPackages: [...standard.values()].map((entry) => ({ ...entry, referencedBy: entry.referencedBy.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)) })).sort((a, b) => a.name.localeCompare(b.name)),
    externalModules: [...external.values()].map((entry) => ({ ...entry, referencedBy: entry.referencedBy.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)) })).sort((a, b) => a.name.localeCompare(b.name)),
    unresolvedImports: unresolved.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)),
    excludedFiles: analysis.excludedFiles,
    importDeclarations: {
      discovery: "independent-go-import-line-scan",
      expected: declarations.length,
      observed: edges.length,
      missing,
    },
    resolutionRules: {
      moduleRoots: modulesByPathLength.map((module) => ({ modulePath: module.modulePath, root: module.root, workspaceMember: module.workspaceMember })).sort((a, b) => a.modulePath.localeCompare(b.modulePath)),
      localReplaces: analysis.modules.flatMap((module) => module.replaces.filter((replace) => replace.local).map((replace) => ({ from: replace.from, to: replace.to }))).sort((a, b) => a.from.localeCompare(b.from)),
      workspaceUses: analysis.workspaces.flatMap((workspace) => workspace.uses).sort(),
      standardLibraryRule: "first-path-segment-without-dot",
    },
    omissions: omissions.sort((a, b) => a.id.localeCompare(b.id)),
    gates: {
      blockedViews: blockingReasons.length > 0 ? ["module-architecture", "full-declared-scope"] : [],
      runtimeOverviewUnaffected: true,
      reasons: [...blockingReasons, ...notes],
    },
    statistics: {
      packages: nodes.length,
      edges: edges.length,
      internalEdges: internalEdges.length,
      crossModuleEdges: edges.filter((edge) => edge.crossModule).length,
      standardLibraryEdges: edges.filter((edge) => edge.toKind === "standard-library").length,
      externalEdges: edges.filter((edge) => edge.toKind === "external").length,
      unresolvedImports: unresolved.length,
      cycles: cycles.length,
      excludedFiles: analysis.excludedFiles.length,
      parsedFiles: includedFiles.length,
      callExpressions: nodes.reduce((total, node) => total + node.callExpressions, 0),
      modules: analysis.modules.length,
      workspaces: analysis.workspaces.length,
      evidenceRecords: dedupedEvidence.length,
    },
    evidenceRecords: dedupedEvidence,
  });
}

/** One reference per Go package edge, so projection reconciliation covers Go AST evidence too. */
export function goModuleGraphEvidenceReferences(graph: GoModuleGraph): EvidenceReference[] {
  return graph.edges.map((edge) => evidenceReferenceSchema.parse({
    ownerType: "go-module-edge",
    ownerId: edge.id,
    evidenceIds: edge.evidenceIds,
    renderedEvidenceIds: edge.evidenceIds.slice(0, 3),
    remainingEvidenceIds: edge.evidenceIds.slice(3),
    selectionReason: "Tree-sitter Go import spec; the complete set is retained in evidenceIds and in the evidence index",
  }));
}

export function viewsBlockedByGoModuleGraph(graph: GoModuleGraph) {
  return graph.gates.blockedViews;
}
