import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { architectureDocumentSchema, type ArchitectureDocument } from "./document.js";
import { projectArchitectureDocument } from "./project.js";
import type { ViewManifest, ViewPage } from "./view-manifest.js";
import { deliverArchify, visualCheckArchify, type ArchifyReceipt } from "../archify-cli.js";
import { writeJsonAtomic } from "../json.js";

export function withoutRepositoryEvidence(document: ArchitectureDocument) {
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

export interface ViewArtifact {
  kind: ViewPage["kind"];
  owner: string;
  page: number;
  json: string;
  html: string;
  validationReceipt?: ArchifyReceipt;
  visualReceipt?: ArchifyReceipt;
}

export interface DeliverViewArtifactsInput {
  outDir: string;
  productName: string;
  productSlug: string;
  owner: string;
  revision: string;
  locale: "en" | "zh-CN";
  pages: ViewPage[];
  manifest: ViewManifest;
  render: boolean;
  visualCheck: boolean;
  renderPage?: (page: ViewPage) => boolean;
  deliver?: typeof deliverArchify;
  check?: typeof visualCheckArchify;
}

export async function deliverViewArtifacts(input: DeliverViewArtifactsInput): Promise<ViewArtifact[]> {
  const viewsPath = join(input.outDir, "architecture.views.json");
  await writeJsonAtomic(viewsPath, input.manifest);
  const deliver = input.deliver ?? deliverArchify;
  const check = input.check ?? visualCheckArchify;
  const artifacts: ViewArtifact[] = [];
  for (const page of input.pages) {
    const entry = input.manifest.views.find((view) => view.kind === page.kind && view.owner === page.owner)?.pages.find((candidate) => candidate.page === page.page);
    if (!entry) throw new Error(`View manifest page is missing: ${page.kind}:${page.owner}:${page.page}`);
    const shouldRender = input.render && (input.renderPage?.(page) ?? true);
    const spec = withoutRepositoryEvidence(projectArchitectureDocument({
      productName: input.productName,
      productSlug: input.productSlug,
      owner: input.owner,
      provider: "github",
      name: input.productName,
      revision: input.revision,
      locale: input.locale,
    }, page.facts, { layout: shouldRender ? "full" : "grid" }));
    const legacyOverview = shouldRender && page.kind === "overview" && page.page === 1;
    const specPath = legacyOverview ? join(input.outDir, "architecture.json") : join(input.outDir, entry.json);
    const artifactPath = legacyOverview ? join(input.outDir, "architecture.html") : join(input.outDir, entry.html);
    await writeJsonAtomic(specPath, spec);
    if (!shouldRender) continue;
    const validationReceipt = await deliver({ type: "architecture", input: specPath, output: artifactPath, quality: "standard" });
    const visualReceipt = input.visualCheck ? await check({ artifact: artifactPath }) : undefined;
    artifacts.push({ kind: page.kind, owner: page.owner, page: page.page, json: specPath, html: artifactPath, validationReceipt, visualReceipt });
    if (legacyOverview) {
      await copyFile(specPath, join(input.outDir, entry.json));
      if (existsSync(artifactPath)) await copyFile(artifactPath, join(input.outDir, entry.html));
    }
  }
  return artifacts;
}
