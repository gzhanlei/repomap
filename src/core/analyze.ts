import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { analyzeRepositoryArchitecture } from "./architecture/repository.js";
import type { LanguageAdapter } from "./architecture/project/adapter.js";
import { externalCandidateSetSchema } from "./architecture/candidates.js";
import { buildViewManifest, validateViewManifest } from "./architecture/view-manifest.js";
import { deliverViewArtifacts } from "./architecture/view-delivery.js";
import type { ArchitectureRepositorySourceReceipt, ArchitectureSource } from "./architecture/source.js";
import type { RepositoryFileEntry } from "./architecture/census.js";
import { linkCensusEvidence } from "./architecture/census.js";
import { mergeEvidenceIndex } from "./architecture/evidence-index.js";
import { buildArchitectureIr, buildProjectionManifest } from "./architecture/ir.js";
import { buildDeliveryStatement, defaultArchitectureView, repomapCapabilities, type DeclaredScopeInput } from "./architecture/scope.js";
import { evaluateArchitectureViews } from "./architecture/coverage-matrix.js";
import { runIndependenceMutations } from "./architecture/independence.js";
import { type ArchifyReceipt, type deliverArchify, type visualCheckArchify } from "./archify-cli.js";
import { parseGitHubRepository } from "./github/repository.js";
import { loadGitHubRepositorySources, type GitHubSourceOptions } from "./github/archive.js";
import { loadLocalRepositorySources, verifyLocalGitRevision } from "./source/local.js";
import { writeJsonAtomic } from "./json.js";

interface RepositoryIdentity {
  kind: "github" | "local";
  owner: string;
  repo: string;
  revision: string;
}

interface AnalyzeSourcesInput extends Partial<Omit<DeclaredScopeInput, "revision" | "languages" | "packageManagers" | "workspaces">> {
  identity: RepositoryIdentity;
  sources: ArchitectureSource[];
  sourceReceipt: ArchitectureRepositorySourceReceipt;
  inventory?: RepositoryFileEntry[];
  rawBudgets?: { maxRawEntries?: number; maxRawBytes?: number; maxRawEntryBytes?: number };
  outDir: string;
  locale?: "en" | "zh-CN";
  render?: boolean;
  visualCheck?: boolean;
  archive?: { bytes: number; sha256: string; cacheHit: boolean; httpRequests: number };
  now?: () => number;
  adapters?: LanguageAdapter[];
  deliver?: typeof deliverArchify;
  check?: typeof visualCheckArchify;
}

export interface AnalyzeOptions extends GitHubSourceOptions {
  source: string;
  revision?: string;
  outDir?: string;
  locale?: "en" | "zh-CN";
  render?: boolean;
  visualCheck?: boolean;
  include?: string[];
  exclude?: string[];
  userExclusions?: string[];
  requestedViews?: string[];
  strictExternalHosts?: boolean;
  rawBudgets?: { maxRawEntries?: number; maxRawBytes?: number; maxRawEntryBytes?: number };
}

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "repository";
}

async function writeJson(path: string, value: unknown) {
  await writeJsonAtomic(path, value);
}

function fixedRevision(value: string) {
  if (!/^[a-fA-F0-9]{40}$/.test(value)) throw new Error("A 40-character fixed revision is required");
  return value.toLowerCase();
}

export async function analyzeSources(input: AnalyzeSourcesInput) {
  const started = input.now?.() ?? Date.now();
  const outDir = resolve(input.outDir);
  await mkdir(outDir, { recursive: true });
  let analysis = analyzeRepositoryArchitecture({
    revision: input.identity.revision,
    sources: input.sources,
    sourceReceipt: input.sourceReceipt,
    inventory: input.inventory,
    userExclusions: input.userExclusions,
    include: input.include,
    exclude: input.exclude,
    requestedViews: input.requestedViews,
    strictExternalHosts: input.strictExternalHosts,
    buildContext: input.buildContext,
    rawBudgets: input.rawBudgets,
    adapters: input.adapters,
  });
  const factsPath = join(outDir, "architecture.facts.json");
  const analysisPath = join(outDir, "architecture.analysis.json");
  const candidatesPath = join(outDir, "architecture.candidates.json");
  const censusPath = join(outDir, "architecture.source-census.json");
  const evidencePath = join(outDir, "architecture.evidence.json");
  const declarationsPath = join(outDir, "architecture.declarations.json");
  const projectPath = join(outDir, "architecture.project.json");
  const moduleGraphPath = join(outDir, "architecture.module-graph.json");
  const goModuleGraphPath = join(outDir, "architecture.go-module-graph.json");
  const routeGraphPath = join(outDir, "architecture.route-graph.json");
  const asyncGraphPath = join(outDir, "architecture.async-graph.json");
  const irPath = join(outDir, "architecture.ir.json");
  const projectionPath = join(outDir, "architecture.projection.json");
  const viewsPath = join(outDir, "architecture.views.json");
  const receiptPath = join(outDir, "repomap.receipt.json");
  const specPath = join(outDir, "architecture.json");
  const artifactPath = join(outDir, "architecture.html");

  // M1/M6 dual-write: facts v1 stays byte-for-byte compatible; the lossless
  // set is IR v2 + Evidence Index + Projection/View Manifests.
  await writeJson(factsPath, analysis.facts);
  await writeJson(candidatesPath, externalCandidateSetSchema.parse({ version: 1, revision: input.identity.revision, candidates: analysis.candidates }));
  await writeJson(declarationsPath, analysis.declarations);
  await writeJson(projectPath, analysis.project);
  await writeJson(moduleGraphPath, analysis.moduleGraph);
  await writeJson(goModuleGraphPath, analysis.goModuleGraph);
  await writeJson(routeGraphPath, analysis.routeGraph);
  await writeJson(asyncGraphPath, analysis.asyncGraph);
  let viewModel = buildViewManifest(analysis);
  if (viewModel.detailFacts.length > 0 || viewModel.additionalEvidenceRecords.length > 0) {
    const evidence = mergeEvidenceIndex(analysis.evidence, viewModel.additionalEvidenceRecords, []);
    const ir = buildArchitectureIr({
      revision: analysis.ir.revision,
      view: analysis.ir.view,
      scope: analysis.scope,
      facts: analysis.facts,
      evidence,
      declarations: analysis.declarations,
      census: analysis.census,
      omissions: analysis.omissions,
      operations: analysis.ir.operations,
      additionalFacts: viewModel.detailFacts,
    });
    const projection = buildProjectionManifest({ revision: analysis.ir.revision, view: analysis.ir.view, evidence, ir });
    const census = linkCensusEvidence(analysis.census, evidence);
    analysis = { ...analysis, evidence, ir, projection, census };
    viewModel = buildViewManifest(analysis);
  }
  await writeJson(censusPath, analysis.census);
  await writeJson(evidencePath, analysis.evidence);
  await writeJson(irPath, analysis.ir);
  viewModel = { ...viewModel, manifest: { ...viewModel.manifest, roundtrip: validateViewManifest(viewModel.manifest, viewModel.pages, analysis.evidence.records, analysis.ir, viewModel.detailFacts) } };
  await writeJson(projectionPath, analysis.projection);
  await writeJson(viewsPath, viewModel.manifest);

  const rawBudgetExceeded = analysis.census.rawBudgetExceeded;
  const declarationBlocksRuntime = analysis.declarationCoverage.blockingViews.includes("runtime-overview");
  const omissionBlocksRuntime = analysis.omissions.some((omission) => omission.blocking && omission.affectedViews.includes("runtime-overview"));
  const unresolvedExternalHosts = analysis.candidates.filter((candidate) => candidate.status === "omitted" || candidate.target?.kind !== "host" || candidate.target.resolution !== "static");
  const strictExternalHostsFailed = input.strictExternalHosts === true && unresolvedExternalHosts.length > 0;
  const independence = analysis.scope.requestedViews.includes("full-declared-scope")
    ? runIndependenceMutations({ revision: input.identity.revision, scope: "repository" }, input.sources, {
      baseline: analysis,
      inventory: input.inventory,
      include: input.include,
      exclude: input.exclude,
      userExclusions: input.userExclusions,
      rawBudgets: input.rawBudgets,
      buildContext: input.buildContext,
    })
    : undefined;
  const evaluation = evaluateArchitectureViews(analysis, { strictExternalHosts: input.strictExternalHosts, independence, viewManifest: viewModel.manifest, viewPages: viewModel.pages, viewDetails: viewModel.detailFacts });
  const fullArchitecture = evaluation.fullArchitecture && analysis.scope.requestedViews.includes("full-declared-scope");
  const publishable = evaluation.views["runtime-overview"].status === "passed";
  const evidenceProjection = {
    renderLimit: analysis.evidence.statistics.renderLimit,
    owners: analysis.projection.totals.owners,
    hiddenEvidenceCount: analysis.projection.totals.hidden,
    completeIndex: evidencePath,
  };
  const baseReceipt = {
    engine: "repomap-v1",
    repository: input.identity,
    view: defaultArchitectureView,
    requestedViews: analysis.scope.requestedViews,
    fullArchitecture,
    viewCoverage: evaluation,
    viewManifest: viewModel.manifest,
    declaredScope: analysis.scope,
    capabilities: repomapCapabilities,
    source: analysis.sourceReceipt,
    census: analysis.census.totals,
    rawBudgetExceeded,
    externalHostGate: {
      required: input.strictExternalHosts === true,
      unresolved: unresolvedExternalHosts.map((candidate) => candidate.id),
    },
    evidenceProjection,
    declarationCoverage: analysis.declarationCoverage,
    mutation: analysis.mutation,
    independence,
    project: {
      snapshotId: analysis.snapshotId,
      parsers: analysis.project.parsers,
      units: analysis.project.statistics.units,
      unresolvedImports: analysis.project.statistics.unresolvedImports,
      parseErrors: analysis.project.statistics.parseErrors,
      blockedViews: analysis.project.gates.blockedViews,
    },
    moduleGraph: {
      snapshotId: analysis.moduleGraph.snapshotId,
      granularity: analysis.moduleGraph.granularity,
      statistics: analysis.moduleGraph.statistics,
      blockedViews: analysis.moduleGraph.gates.blockedViews,
      runtimeOverviewUnaffected: analysis.moduleGraph.gates.runtimeOverviewUnaffected,
    },
    goModuleGraph: {
      snapshotId: analysis.goModuleGraph.snapshotId,
      granularity: analysis.goModuleGraph.granularity,
      parser: analysis.goModuleGraph.parser,
      buildContext: analysis.goModuleGraph.buildContext,
      statistics: analysis.goModuleGraph.statistics,
      blockedViews: analysis.goModuleGraph.gates.blockedViews,
      runtimeOverviewUnaffected: analysis.goModuleGraph.gates.runtimeOverviewUnaffected,
    },
    routeGraph: {
      snapshotId: analysis.routeGraph.snapshotId,
      coverage: analysis.routeGraph.coverage,
      statistics: analysis.routeGraph.statistics,
      blockedViews: analysis.routeGraph.gates.blockedViews,
      runtimeOverviewUnaffected: analysis.routeGraph.gates.runtimeOverviewUnaffected,
    },
    asyncGraph: {
      snapshotId: analysis.asyncGraph.snapshotId,
      coverage: analysis.asyncGraph.coverage,
      statistics: analysis.asyncGraph.statistics,
      blockedViews: analysis.asyncGraph.gates.blockedViews,
      runtimeOverviewUnaffected: analysis.asyncGraph.gates.runtimeOverviewUnaffected,
    },
    archive: input.archive,
    aiRequests: 0,
    candidateSummary: { total: analysis.candidates.length, omitted: analysis.candidates.filter((candidate) => candidate.status === "omitted").length },
    coverage: analysis.coverage,
    outputs: {
      facts: factsPath, analysis: analysisPath, candidates: candidatesPath, census: censusPath,
      evidence: evidencePath, declarations: declarationsPath, project: projectPath,
      moduleGraph: moduleGraphPath, goModuleGraph: goModuleGraphPath, routeGraph: routeGraphPath, asyncGraph: asyncGraphPath, ir: irPath, projection: projectionPath, views: viewsPath, receipt: receiptPath,
    },
  };
  const deliveryFor = (status: "accepted" | "facts-ready" | "failed", visualPassed?: boolean) => buildDeliveryStatement({
    status, publishable, requestedViews: input.requestedViews, visualPassed,
    strictExternalHosts: input.strictExternalHosts,
    evaluation,
    blockingOmissionCount: analysis.omissions.filter((omission) => omission.blocking).length
      + analysis.declarationCoverage.missing.filter((declaration) => ["entrypoint", "deployable", "route"].includes(declaration.kind) || declaration.capability === "unresolved-submodule").length
      + (strictExternalHostsFailed ? unresolvedExternalHosts.length : 0),
  });
  let viewArtifacts: Awaited<ReturnType<typeof deliverViewArtifacts>> = [];
  const analysisOutput = (status: "accepted" | "facts-ready" | "failed") => ({
    version: 2,
    view: defaultArchitectureView,
    fullArchitecture,
    viewCoverage: evaluation,
    delivery: deliveryFor(status),
    declaredScope: analysis.scope,
    capabilities: repomapCapabilities,
    declarations: {
      total: analysis.declarations.statistics.total,
      critical: analysis.declarations.statistics.critical,
      capabilityGaps: analysis.declarations.capabilityGaps,
      protocolGaps: analysis.declarations.protocolGaps,
    },
    declarationCoverage: analysis.declarationCoverage,
    mutation: analysis.mutation,
    independence,
    project: {
      snapshotId: analysis.snapshotId,
      buildContext: analysis.project.buildContext,
      parsers: analysis.project.parsers,
      statistics: analysis.project.statistics,
      gates: analysis.project.gates,
    },
    moduleGraph: analysis.moduleGraph.statistics,
    goModuleGraph: analysis.goModuleGraph.statistics,
    routeGraph: {
      coverage: analysis.routeGraph.coverage,
      statistics: analysis.routeGraph.statistics,
      gates: analysis.routeGraph.gates,
    },
    asyncGraph: {
      coverage: analysis.asyncGraph.coverage,
      statistics: analysis.asyncGraph.statistics,
      gates: analysis.asyncGraph.gates,
    },
    omissions: analysis.omissions,
    viewManifest: viewModel.manifest,
    viewArtifacts,
    externalHostGate: {
      required: input.strictExternalHosts === true,
      unresolved: unresolvedExternalHosts.map((candidate) => candidate.id),
    },
    evidenceProjection,
    rawBudgetExceeded,
    repository: input.identity,
    source: { ...analysis.sourceReceipt, census: analysis.census.totals },
    signals: analysis.inventory.signals,
    coverage: analysis.coverage,
  });

  if (!publishable) {
    const status = "failed" as const;
    await writeJson(analysisPath, analysisOutput(status));
    const receipt = {
      ...baseReceipt, status, delivery: deliveryFor(status),
      error: rawBudgetExceeded
        ? "Raw source entry budget exceeded; no view is publishable"
        : strictExternalHostsFailed
          ? `External hosts are not fully resolved: ${unresolvedExternalHosts.map((candidate) => candidate.id).join(", ")}`
          : declarationBlocksRuntime
          ? "Independent declaration coverage is not publishable"
          : omissionBlocksRuntime
            ? "Architecture omissions are not publishable"
            : "Architecture coverage is not publishable",
      elapsedMs: (input.now?.() ?? Date.now()) - started,
      visualReview: "not-requested",
    };
    await writeJson(receiptPath, receipt);
    return receipt;
  }

  const render = input.render !== false;
  const visualCheck = input.visualCheck === true;
  let validationReceipt: ArchifyReceipt | undefined;
  let visualReceipt: ArchifyReceipt | undefined;
  try {
    viewArtifacts = await deliverViewArtifacts({
      outDir,
      productName: input.identity.repo,
      productSlug: slugify(input.identity.repo),
      owner: input.identity.owner,
      revision: input.identity.revision,
      locale: input.locale ?? "en",
      pages: viewModel.pages,
      manifest: viewModel.manifest,
      render,
      visualCheck,
      renderPage: (page) => {
        if (page.kind === "overview") {
          const requested = analysis.scope.requestedViews.some((view) => view === "runtime-overview" || view === "system-context");
          return requested && evaluation.views["runtime-overview"].status === "passed";
        }
        const view = page.kind === "modules" ? "module-architecture" : "protocol-flows";
        return analysis.scope.requestedViews.includes(view) && evaluation.views[view].status === "passed";
      },
      deliver: input.deliver,
      check: input.check,
    });
    validationReceipt = viewArtifacts.find((artifact) => artifact.kind === "overview" && artifact.page === 1)?.validationReceipt;
    visualReceipt = viewArtifacts.find((artifact) => artifact.kind === "overview" && artifact.page === 1)?.visualReceipt;
    const status = render ? "accepted" as const : "facts-ready" as const;
    const delivery = deliveryFor(status, render && visualCheck && visualReceipt?.ok === true);
    const overallStatus = delivery.status;
    await writeJson(analysisPath, analysisOutput(overallStatus));
    const receipt = {
      ...baseReceipt,
      status: overallStatus,
      delivery,
      error: overallStatus === "failed" ? delivery.reason : null,
      elapsedMs: (input.now?.() ?? Date.now()) - started,
      outputs: { ...baseReceipt.outputs, viewArtifacts, ...(render && viewArtifacts.some((artifact) => artifact.kind === "overview" && artifact.page === 1) ? { spec: specPath, artifact: artifactPath } : {}) },
      validationReceipt,
      visualReceipt,
      viewArtifacts,
      visualReview: render && visualCheck ? "pending" : "not-requested",
    };
    await writeJson(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const status = "failed" as const;
    await writeJson(analysisPath, analysisOutput(status));
    const receipt = {
      ...baseReceipt,
      status,
      delivery: deliveryFor(status),
      error: error instanceof Error ? error.message : "Architecture rendering failed",
      elapsedMs: (input.now?.() ?? Date.now()) - started,
      validationReceipt,
      visualReceipt,
      viewArtifacts,
      visualReview: "not-requested",
    };
    await writeJson(receiptPath, receipt);
    return receipt;
  }
}

export async function analyzeSource(options: AnalyzeOptions) {
  if (existsSync(options.source)) {
    if (!options.revision) throw new Error("Local source requires --revision with a 40-character Git SHA");
    const identity: RepositoryIdentity = { kind: "local", owner: "local", repo: basename(resolve(options.source)), revision: fixedRevision(options.revision) };
    await verifyLocalGitRevision(options.source, identity.revision);
    const loaded = await loadLocalRepositorySources(options.source, options.budgets);
    return analyzeSources({ ...options, identity, sources: loaded.sources, inventory: loaded.inventory, sourceReceipt: loaded.receipt, outDir: options.outDir ?? join(process.cwd(), "repomap-output", `${slugify(identity.repo)}-${identity.revision.slice(0, 7)}`) });
  }

  const repository = parseGitHubRepository(options.source);
  if (!repository) throw new Error("Source must be a local directory, owner/repo[@SHA], or a GitHub repository URL");
  if (options.revision) repository.revision = fixedRevision(options.revision);
  const loaded = await loadGitHubRepositorySources(repository, options);
  const identity: RepositoryIdentity = { kind: "github", owner: repository.owner, repo: repository.repo, revision: loaded.repository.revision };
  try {
    return await analyzeSources({
      ...options,
      identity,
      sources: loaded.sources,
      inventory: loaded.inventory,
      sourceReceipt: loaded.receipt,
      archive: loaded.archive,
      outDir: options.outDir ?? join(process.cwd(), "repomap-output", `${slugify(repository.repo)}-${identity.revision.slice(0, 7)}`),
    });
  } finally {
    await loaded.cleanup();
  }
}
