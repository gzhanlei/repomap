import { architectureFactSetSchema, type ArchitectureFactSet, type EdgeFact, type NodeFact } from "./facts.js";
import { collectArchitectureSignals, type ArchitectureSignalInventory } from "./signals.js";
import { evaluateArchitectureCoverage } from "./coverage.js";
import { uniqueEvidence, isArchitectureSourcePath, type ArchitectureSource } from "./source.js";
import { isLockfilePath } from "./file-roles.js";
import { nextArchitectureDetector } from "./detectors/next.js";
import { goArchitectureDetector } from "./detectors/go.js";
import { phpArchitectureDetector } from "./detectors/php.js";
import { linkStorageRelationships, storageArchitectureDetector } from "./detectors/storage.js";
import { externalArchitectureDetector, externalCallbackRelationships, linkExternalRelationships } from "./detectors/external.js";
import { miniProgramApiRelationships, miniProgramArchitectureDetector } from "./detectors/mini-program.js";
import { goInternalHttpRelationships } from "./detectors/go-http.js";
import { packageDeployableFragment } from "./detectors/package.js";
import { emptyArchitectureFragment, type ArchitectureContext, type ArchitectureFragment } from "./detectors/types.js";
import { detectGenericExternal, genericExternalCandidates } from "./detectors/generic-external.js";
import type { ExternalCandidate } from "./candidates.js";
import { assertSourceCensusReconciled, buildSourceCensus, linkCensusDeclarations, linkCensusEvidence, type RepositoryFileEntry } from "./census.js";
import { buildDeclarationInventory, evaluateDeclarationCoverage, mutationCheck } from "./declarations.js";
import { assertEvidenceReferences, buildEvidenceIndex, mergeEvidenceIndex } from "./evidence-index.js";
import { buildArchitectureIr, buildProjectionManifest, irEvidenceIds, type IrOmission } from "./ir.js";
import { buildDeclaredScope, defaultArchitectureView, type DeclaredScopeInput } from "./scope.js";
import { createSourceSnapshot } from "./project/snapshot.js";
import { prepareProjects } from "./project/prepare.js";
import { buildModuleGraph, moduleGraphEvidenceReferences } from "./project/module-graph.js";
import { buildGoModuleGraph, goModuleGraphEvidenceReferences } from "./project/go-module-graph.js";
import type { LanguageAdapter } from "./project/adapter.js";

const detectors = [nextArchitectureDetector, goArchitectureDetector, phpArchitectureDetector, miniProgramArchitectureDetector, storageArchitectureDetector, externalArchitectureDetector];

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}

function mergeNodes(nodes: NodeFact[]) {
  const merged = new Map<string, NodeFact>();
  for (const node of nodes) {
    const existing = merged.get(node.id);
    if (!existing) { merged.set(node.id, node); continue; }
    if (existing.kind !== node.kind) throw new Error(`Conflicting architecture node kind: ${node.id}`);
    merged.set(node.id, {
      ...existing,
      signalIds: uniqueStrings([...existing.signalIds, ...node.signalIds]),
      sourcePaths: uniqueStrings([...(existing.sourcePaths ?? []), ...(node.sourcePaths ?? [])]),
      evidence: uniqueEvidence([...existing.evidence, ...node.evidence]),
    });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeEdges(edges: EdgeFact[]) {
  const merged = new Map<string, EdgeFact>();
  for (const edge of edges) {
    const existing = merged.get(edge.id);
    if (!existing) { merged.set(edge.id, edge); continue; }
    if (existing.from !== edge.from || existing.to !== edge.to || existing.kind !== edge.kind) throw new Error(`Conflicting architecture relationship: ${edge.id}`);
    merged.set(edge.id, { ...existing, signalIds: uniqueStrings([...existing.signalIds, ...edge.signalIds]), evidence: uniqueEvidence([...existing.evidence, ...edge.evidence]) });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeArchitectureFragments(revision: string, fragments: ArchitectureFragment[]): ArchitectureFactSet {
  const nodes = mergeNodes(fragments.flatMap((fragment) => fragment.nodes));
  const edges = mergeEdges(fragments.flatMap((fragment) => fragment.edges));
  const roots = uniqueStrings(fragments.flatMap((fragment) => fragment.roots));
  const omissions = fragments.flatMap((fragment) => fragment.omissions);
  return architectureFactSetSchema.parse({ version: 1, revision, roots, nodes, edges, omissions });
}

function extractWithInventory(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[], inventory: ArchitectureSignalInventory): { facts: ArchitectureFactSet; candidates: ExternalCandidate[] } {
  const context: ArchitectureContext = { ...input, sources, signals: inventory.signals };
  const fragments = detectors.map((detector) => detector.detect(context));
  const base = mergeArchitectureFragments(input.revision, fragments);
  const withDeployables = mergeArchitectureFragments(input.revision, [base, packageDeployableFragment(context, base.nodes)]);
  const generic = detectGenericExternal(context, withDeployables.nodes);
  const augmented = mergeArchitectureFragments(input.revision, [withDeployables, generic]);
  const storageEdges = linkStorageRelationships(context, augmented.nodes);
  const relationshipEdges = [
    ...storageEdges,
    ...linkExternalRelationships(context, augmented.nodes),
    ...externalCallbackRelationships(context, augmented.nodes),
    ...miniProgramApiRelationships(context, base.nodes),
    ...goInternalHttpRelationships(context, base.nodes),
  ];
  const callbackRoots = relationshipEdges.filter((edge) => edge.kind === "callback").map((edge) => edge.from);
  const facts = mergeArchitectureFragments(input.revision, [{ ...emptyArchitectureFragment(), nodes: augmented.nodes, edges: augmented.edges, roots: [...augmented.roots, ...callbackRoots], omissions: augmented.omissions }, { ...emptyArchitectureFragment(), edges: relationshipEdges }]);
  return { facts, candidates: generic.candidates };
}

export interface ArchitectureAnalysisOptions extends Partial<Omit<DeclaredScopeInput, "revision" | "languages" | "packageManagers" | "workspaces">> {
  inventory?: RepositoryFileEntry[];
  rawBudgets?: { maxRawEntries?: number; maxRawBytes?: number; maxRawEntryBytes?: number };
  /** Injectable for parser-unavailable tests; defaults to the shipped adapter set. */
  adapters?: LanguageAdapter[];
}

function omissionsFrom(census: ReturnType<typeof buildSourceCensus>, declarations: ReturnType<typeof buildDeclarationInventory>, facts: ArchitectureFactSet): IrOmission[] {
  const result: IrOmission[] = [];
  for (const omission of census.omissions) {
    const reason = omission.reason === "submodule-gitlink" ? "unresolved-submodule"
      : omission.reason === "budget-exceeded" ? "budget-exceeded"
        : omission.reason === "unsupported-language" ? "unsupported-language" : "parser-unavailable";
    result.push({
      id: omission.id, owner: omission.path, reason, detail: `raw entry disposition: ${omission.reason}`,
      declarationIds: [], evidenceIds: [], affectedViews: omission.affectedViews, blocking: omission.blocking,
    });
  }
  for (const gap of declarations.capabilityGaps) {
    const repositoryWide = gap === "unresolved-submodule" || gap === "unparseable-manifest";
    result.push({
      id: `omission:capability:${gap}`, owner: "capability-discovery",
      reason: gap.startsWith("unsupported-framework") ? "unsupported-framework" : gap.startsWith("unsupported-language") ? "unsupported-language" : gap === "unresolved-submodule" ? "unresolved-submodule" : "parser-unavailable",
      detail: gap,
      declarationIds: [],
      evidenceIds: [],
      affectedViews: repositoryWide ? ["system-context", "runtime-overview", "module-architecture", "protocol-flows", "full-declared-scope"] : ["module-architecture", "full-declared-scope"],
      blocking: true,
    });
  }
  for (const gap of declarations.protocolGaps) {
    result.push({
      id: `omission:protocol:${gap}`, owner: "protocol-capability-discovery", reason: "unsupported-protocol",
      detail: gap, declarationIds: [], evidenceIds: [], affectedViews: ["protocol-flows", "full-declared-scope"], blocking: true,
    });
  }
  const v1Reasons = { unsupported: "unsupported-syntax", "out-of-scope": "out-of-scope", duplicate: "duplicate", uncertain: "uncertain-direction" } as const;
  for (const omission of facts.omissions) {
    result.push({
      id: `omission:v1:${omission.signalId}`, owner: omission.signalId, reason: v1Reasons[omission.reason],
      detail: omission.detail, declarationIds: [], evidenceIds: [], affectedViews: ["runtime-overview"], blocking: true,
    });
  }
  return result;
}

export function analyzeArchitectureFacts(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[], options: ArchitectureAnalysisOptions = {}) {
  // Lockfiles remain in the raw census but never enter evidence or signal scans.
  const candidateSources = sources.filter((source) => isArchitectureSourcePath(source.path) && !isLockfilePath(source.path));
  const rawEntries: RepositoryFileEntry[] = options.inventory ?? sources.map((source) => ({ path: source.path, size: 0, entryKind: "file" as const, selected: true }));
  const baseCensus = buildSourceCensus({
    revision: input.revision,
    inventory: rawEntries,
    userExclusions: options.userExclusions,
    exclude: options.exclude,
    include: options.include,
    budgets: options.rawBudgets,
  });
  assertSourceCensusReconciled(baseCensus);
  const selectedPaths = new Set(baseCensus.files.filter((file) => file.status === "selected").map((file) => file.path));
  const runtimeSources = candidateSources.filter((source) => selectedPaths.has(source.path));

  // Project preparation consumes immutable raw text; it never changes facts v1.
  const snapshot = createSourceSnapshot({ revision: input.revision, sources: runtimeSources, census: baseCensus });
  const project = prepareProjects({
    revision: input.revision,
    snapshot,
    census: baseCensus,
    buildContext: options.buildContext,
    adapters: options.adapters,
  });
  // PR #6: the module graph is derived from the same immutable snapshot and
  // project units; it never mutates facts v1.
  const moduleGraph = buildModuleGraph({ revision: input.revision, snapshot, census: baseCensus, project });
  // PR #7: the Go package graph is a second, package-granularity graph derived
  // from the SAME immutable snapshot and project units. Neither graph mutates
  // facts v1, and both feed the single lossless evidence index.
  const goModuleGraph = buildGoModuleGraph({ revision: input.revision, snapshot, census: baseCensus, project });

  // Independent declaration discovery runs before any semantic detector.
  const rawDeclarations = buildDeclarationInventory({ revision: input.revision, census: baseCensus, sources: runtimeSources });
  const censusWithDeclarations = linkCensusDeclarations(baseCensus, rawDeclarations);

  const inventory = collectArchitectureSignals(input, runtimeSources);
  const generic = genericExternalCandidates({ ...input, sources: runtimeSources, signals: inventory.signals });
  const signals = [...inventory.signals, ...generic.signals].sort((a, b) => a.id.localeCompare(b.id));
  const enrichedInventory = { ...inventory, signals };
  const { facts, candidates } = extractWithInventory(input, runtimeSources, enrichedInventory);
  const coverage = evaluateArchitectureCoverage(enrichedInventory, facts);
  const declarationCoverage = evaluateDeclarationCoverage(rawDeclarations, facts);
  const mutation = mutationCheck(rawDeclarations, facts);
  // One lossless index: regex runtime evidence + TS AST import evidence + Go AST import evidence.
  const evidence = mergeEvidenceIndex(
    buildEvidenceIndex(input.revision, facts),
    [...moduleGraph.evidenceRecords, ...goModuleGraph.evidenceRecords],
    [...moduleGraphEvidenceReferences(moduleGraph), ...goModuleGraphEvidenceReferences(goModuleGraph)],
  );
  const declarations = {
    ...rawDeclarations,
    declarations: rawDeclarations.declarations.map((declaration) => ({
      ...declaration,
      evidenceIds: evidence.records.filter((record) => record.path === declaration.sourcePath).map((record) => record.id).sort(),
    })),
  };
  const scope = buildDeclaredScope({
    revision: input.revision,
    languages: [...new Set(baseCensus.files.map((file) => file.language))].filter((language) => language !== "unknown"),
    packageManagers: baseCensus.packages.flatMap((entry) => entry.managers),
    workspaces: baseCensus.packages.map((entry) => entry.id),
    include: options.include,
    exclude: options.exclude,
    userExclusions: options.userExclusions,
    requestedViews: options.requestedViews,
    strictExternalHosts: options.strictExternalHosts,
    buildContext: options.buildContext,
    parsers: project.parsers,
  });
  const omissions = [...omissionsFrom(baseCensus, rawDeclarations, facts), ...project.omissions, ...moduleGraph.omissions, ...goModuleGraph.omissions];
  const ir = buildArchitectureIr({ revision: input.revision, view: defaultArchitectureView, scope, facts, evidence, declarations, census: censusWithDeclarations, omissions });
  assertEvidenceReferences(evidence, irEvidenceIds(ir));
  const projection = buildProjectionManifest({ revision: input.revision, view: defaultArchitectureView, evidence, ir });
  const census = linkCensusEvidence(censusWithDeclarations, evidence);
  return {
    inventory: enrichedInventory, facts, coverage, candidates,
    census, evidence, declarations, declarationCoverage, mutation,
    scope, ir, projection, omissions, project, moduleGraph, goModuleGraph, snapshotId: snapshot.snapshotId,
    view: defaultArchitectureView,
  };
}

export function extractArchitectureFacts(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[]): ArchitectureFactSet {
  return analyzeArchitectureFacts(input, sources).facts;
}
