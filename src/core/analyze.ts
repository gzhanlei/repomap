import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { analyzeRepositoryArchitecture } from "./architecture/repository.js";
import type { LanguageAdapter } from "./architecture/project/adapter.js";
import { externalCandidateSetSchema } from "./architecture/candidates.js";
import { projectArchitectureDocument } from "./architecture/project.js";
import { architectureDocumentSchema, type ArchitectureDocument } from "./architecture/document.js";
import type { ArchitectureRepositorySourceReceipt, ArchitectureSource } from "./architecture/source.js";
import type { RepositoryFileEntry } from "./architecture/census.js";
import { buildDeliveryStatement, defaultArchitectureView, repomapCapabilities, type DeclaredScopeInput } from "./architecture/scope.js";
import { deliverArchify, visualCheckArchify, type ArchifyReceipt } from "./archify-cli.js";
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

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown) {
  await writeJsonAtomic(path, value);
}

function withoutRepositoryEvidence(document: ArchitectureDocument) {
  const meta = { ...document.meta };
  delete meta.repository;
  return architectureDocumentSchema.parse({
    ...document,
    meta,
    components: document.components.map((component) => {
      const next = { ...component };
      delete next.sources;
      return next;
    }),
  });
}

function fixedRevision(value: string) {
  if (!/^[a-fA-F0-9]{40}$/.test(value)) throw new Error("A 40-character fixed revision is required");
  return value.toLowerCase();
}

export async function analyzeSources(input: AnalyzeSourcesInput) {
  const started = input.now?.() ?? Date.now();
  const outDir = resolve(input.outDir);
  await mkdir(outDir, { recursive: true });
  const analysis = analyzeRepositoryArchitecture({
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
  const irPath = join(outDir, "architecture.ir.json");
  const projectionPath = join(outDir, "architecture.projection.json");
  const receiptPath = join(outDir, "repomap.receipt.json");
  const specPath = join(outDir, "architecture.json");
  const artifactPath = join(outDir, "architecture.html");

  // M1 dual-write: facts v1 stays byte-for-byte compatible; the lossless set is
  // IR v2 + Evidence Index + Projection Manifest.
  await writeJson(factsPath, analysis.facts);
  await writeJson(candidatesPath, externalCandidateSetSchema.parse({ version: 1, revision: input.identity.revision, candidates: analysis.candidates }));
  await writeJson(censusPath, analysis.census);
  await writeJson(evidencePath, analysis.evidence);
  await writeJson(declarationsPath, analysis.declarations);
  await writeJson(projectPath, analysis.project);
  await writeJson(moduleGraphPath, analysis.moduleGraph);
  await writeJson(goModuleGraphPath, analysis.goModuleGraph);
  await writeJson(irPath, analysis.ir);
  await writeJson(projectionPath, analysis.projection);

  const rawBudgetExceeded = analysis.census.rawBudgetExceeded;
  const declarationBlocksRuntime = analysis.declarationCoverage.blockingViews.includes("runtime-overview");
  const omissionBlocksRuntime = analysis.omissions.some((omission) => omission.blocking && omission.affectedViews.includes("runtime-overview"));
  const publishable = analysis.coverage.publishable && !rawBudgetExceeded && !declarationBlocksRuntime && !omissionBlocksRuntime;
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
    fullArchitecture: false,
    declaredScope: analysis.scope,
    capabilities: repomapCapabilities,
    source: analysis.sourceReceipt,
    census: analysis.census.totals,
    rawBudgetExceeded,
    evidenceProjection,
    declarationCoverage: analysis.declarationCoverage,
    mutation: analysis.mutation,
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
    archive: input.archive,
    aiRequests: 0,
    candidateSummary: { total: analysis.candidates.length, omitted: analysis.candidates.filter((candidate) => candidate.status === "omitted").length },
    coverage: analysis.coverage,
    outputs: {
      facts: factsPath, analysis: analysisPath, candidates: candidatesPath, census: censusPath,
      evidence: evidencePath, declarations: declarationsPath, project: projectPath,
      moduleGraph: moduleGraphPath, goModuleGraph: goModuleGraphPath, ir: irPath, projection: projectionPath, receipt: receiptPath,
    },
  };
  const deliveryFor = (status: "accepted" | "facts-ready" | "failed", visualPassed?: boolean) => buildDeliveryStatement({
    status, publishable, requestedViews: input.requestedViews, visualPassed,
    strictExternalHosts: input.strictExternalHosts,
    blockingOmissionCount: analysis.omissions.filter((omission) => omission.blocking).length
      + analysis.declarationCoverage.missing.filter((declaration) => ["entrypoint", "deployable", "route"].includes(declaration.kind) || declaration.capability === "unresolved-submodule").length,
  });
  const analysisOutput = (status: "accepted" | "facts-ready" | "failed") => ({
    version: 2,
    view: defaultArchitectureView,
    fullArchitecture: false,
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
    project: {
      snapshotId: analysis.snapshotId,
      buildContext: analysis.project.buildContext,
      parsers: analysis.project.parsers,
      statistics: analysis.project.statistics,
      gates: analysis.project.gates,
    },
    moduleGraph: analysis.moduleGraph.statistics,
    goModuleGraph: analysis.goModuleGraph.statistics,
    omissions: analysis.omissions,
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
    if (render) {
      const projected = projectArchitectureDocument({
        productName: input.identity.repo,
        productSlug: slugify(input.identity.repo),
        owner: input.identity.owner,
        provider: "github",
        name: input.identity.repo,
        revision: input.identity.revision,
        locale: input.locale ?? "en",
      }, analysis.facts);
      const spec = withoutRepositoryEvidence(projected);
      await writeFile(specPath, json(spec), { mode: 0o600 });
      const deliver = input.deliver ?? deliverArchify;
      validationReceipt = await deliver({ type: "architecture", input: specPath, output: artifactPath, quality: "standard" });
      if (visualCheck) {
        const check = input.check ?? visualCheckArchify;
        visualReceipt = await check({ artifact: artifactPath });
      }
    }
    const status = render ? "accepted" as const : "facts-ready" as const;
    await writeJson(analysisPath, analysisOutput(status));
    const receipt = {
      ...baseReceipt,
      status,
      delivery: deliveryFor(status, render && visualCheck && visualReceipt?.ok === true),
      elapsedMs: (input.now?.() ?? Date.now()) - started,
      outputs: { ...baseReceipt.outputs, ...(render ? { spec: specPath, artifact: artifactPath } : {}) },
      validationReceipt,
      visualReceipt,
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
