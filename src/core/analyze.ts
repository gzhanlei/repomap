import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { analyzeRepositoryArchitecture } from "./architecture/repository.js";
import { externalCandidateSetSchema } from "./architecture/candidates.js";
import { projectArchitectureDocument } from "./architecture/project.js";
import { architectureDocumentSchema, type ArchitectureDocument } from "./architecture/document.js";
import type { ArchitectureRepositorySourceReceipt, ArchitectureSource } from "./architecture/source.js";
import { deliverArchify, visualCheckArchify, type ArchifyReceipt } from "./archify-cli.js";
import { parseGitHubRepository } from "./github/repository.js";
import { loadGitHubRepositorySources, type GitHubSourceOptions } from "./github/archive.js";
import { loadLocalRepositorySources, verifyLocalGitRevision } from "./source/local.js";

interface RepositoryIdentity {
  kind: "github" | "local";
  owner: string;
  repo: string;
  revision: string;
}

interface AnalyzeSourcesInput {
  identity: RepositoryIdentity;
  sources: ArchitectureSource[];
  sourceReceipt: ArchitectureRepositorySourceReceipt;
  outDir: string;
  locale?: "en" | "zh-CN";
  render?: boolean;
  visualCheck?: boolean;
  archive?: { bytes: number; sha256: string; cacheHit: boolean; httpRequests: number };
  now?: () => number;
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
}

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "repository";
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, json(value), { mode: 0o600 });
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
  const analysis = analyzeRepositoryArchitecture({ revision: input.identity.revision, sources: input.sources, sourceReceipt: input.sourceReceipt });
  const factsPath = join(outDir, "architecture.facts.json");
  const analysisPath = join(outDir, "architecture.analysis.json");
  const candidatesPath = join(outDir, "architecture.candidates.json");
  const receiptPath = join(outDir, "repomap.receipt.json");
  const specPath = join(outDir, "architecture.json");
  const artifactPath = join(outDir, "architecture.html");
  await writeJson(factsPath, analysis.facts);
  await writeJson(candidatesPath, externalCandidateSetSchema.parse({ version: 1, revision: input.identity.revision, candidates: analysis.candidates }));
  await writeJson(analysisPath, { version: 1, repository: input.identity, source: analysis.sourceReceipt, signals: analysis.inventory.signals, coverage: analysis.coverage });
  const baseReceipt = {
    engine: "repomap-v1",
    repository: input.identity,
    source: analysis.sourceReceipt,
    archive: input.archive,
    aiRequests: 0,
    candidateSummary: { total: analysis.candidates.length, omitted: analysis.candidates.filter((candidate) => candidate.status === "omitted").length },
    coverage: analysis.coverage,
    outputs: { facts: factsPath, analysis: analysisPath, candidates: candidatesPath, receipt: receiptPath },
  };
  if (!analysis.coverage.publishable) {
    const receipt = { ...baseReceipt, status: "failed" as const, error: "Architecture coverage is not publishable", elapsedMs: (input.now?.() ?? Date.now()) - started };
    await writeJson(receiptPath, receipt);
    return receipt;
  }

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
  const render = input.render !== false;
  const visualCheck = input.visualCheck === true;
  let validationReceipt: ArchifyReceipt | undefined;
  let visualReceipt: ArchifyReceipt | undefined;
  try {
    if (render) {
      const deliver = input.deliver ?? deliverArchify;
      validationReceipt = await deliver({ type: "architecture", input: specPath, output: artifactPath, quality: "standard" });
      if (visualCheck) {
        const check = input.check ?? visualCheckArchify;
        visualReceipt = await check({ artifact: artifactPath });
      }
    }
    const receipt = {
      ...baseReceipt,
      status: render ? "accepted" as const : "facts-ready" as const,
      elapsedMs: (input.now?.() ?? Date.now()) - started,
      outputs: { ...baseReceipt.outputs, spec: specPath, ...(render ? { artifact: artifactPath } : {}) },
      validationReceipt,
      visualReceipt,
      visualReview: visualCheck ? "pending" : "not-requested",
    };
    await writeJson(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const receipt = {
      ...baseReceipt,
      status: "failed" as const,
      error: error instanceof Error ? error.message : "Architecture rendering failed",
      elapsedMs: (input.now?.() ?? Date.now()) - started,
      validationReceipt,
      visualReceipt,
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
    return analyzeSources({ ...options, identity, sources: loaded.sources, sourceReceipt: loaded.receipt, outDir: options.outDir ?? join(process.cwd(), "repomap-output", `${slugify(identity.repo)}-${identity.revision.slice(0, 7)}`) });
  }

  const repository = parseGitHubRepository(options.source);
  if (!repository) throw new Error("Source must be a local directory, owner/repo[@SHA], or a GitHub repository URL");
  if (options.revision) repository.revision = fixedRevision(options.revision);
  const loaded = await loadGitHubRepositorySources(repository, options);
  const identity: RepositoryIdentity = { kind: "github", owner: repository.owner, repo: repository.repo, revision: loaded.repository.revision };
  return analyzeSources({
    ...options,
    identity,
    sources: loaded.sources,
    sourceReceipt: loaded.receipt,
    archive: loaded.archive,
    outDir: options.outDir ?? join(process.cwd(), "repomap-output", `${slugify(repository.repo)}-${identity.revision.slice(0, 7)}`),
  });
}
