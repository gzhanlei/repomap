import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { buildViewManifest, validateViewManifest } from "../src/core/architecture/view-manifest.js";
import { evaluateArchitectureViews } from "../src/core/architecture/coverage-matrix.js";
import { layoutArchitecture } from "../src/core/architecture/layout.js";
import type { ArchitectureDocument } from "../src/core/architecture/document.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const sources = [
  { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
  { path: "app/page.tsx", content: 'import { getProducts } from "../lib/shopify";\nexport default async function Page() { await getProducts(); }' },
  { path: "app/api/products/route.ts", content: 'export async function GET() { return Response.json({ ok: true }); }' },
  { path: "lib/shopify/index.ts", content: 'const endpoint = "https://api.example.com/graphql";\nexport async function getProducts() { return fetch(endpoint, { method: "POST", body: `query getProducts { products { id } }` }); }' },
];

describe("M6 multi-view projection manifest", () => {
  it("builds overview, meaningful module and flow pages with complete roundtrip", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { manifest, pages } = buildViewManifest(analysis, 2);
    expect(manifest.views.some((view) => view.kind === "overview")).toBe(true);
    expect(manifest.views.some((view) => view.kind === "modules")).toBe(true);
    expect(manifest.views.some((view) => view.kind === "flows")).toBe(true);
    expect(manifest.roundtrip.ok).toBe(true);
    expect(validateViewManifest(manifest, pages, analysis.evidence.records).ok).toBe(true);
    const moduleView = manifest.views.find((view) => view.kind === "modules");
    expect(moduleView?.pages.some((page) => page.nodeIds.length > 0)).toBe(true);
    const flowView = manifest.views.find((view) =>
      view.kind === "flows" &&
      view.pages.some((page) =>
        page.operationIds.some((id) => analysis.ir.operations.find((operation) => operation.id === id)?.kind === "graphql"),
      ),
    );
    expect(flowView?.pages.some((page) => page.operationIds.length > 0)).toBe(true);
    expect(
      flowView?.pages.some((page) =>
        page.entities.some((entity) =>
          entity.ownerType === "operation" && entity.irFactIds.length > 0 && page.operationIds.some((id) => analysis.ir.operations.find((operation) => operation.id === id)?.kind === "graphql"),
        ),
      ),
    ).toBe(true);
    expect(
      manifest.views.every((view) =>
        view.pages.every((page) =>
          page.entities.every((entity) =>
            entity.irFactIds.length > 0 &&
            entity.evidenceIds.length === entity.representativeEvidenceIds.length + entity.remainingEvidenceIds.length,
          ),
        ),
      ),
    ).toBe(true);
  });

  it("rejects missing or duplicate projected facts and dangling evidence", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { manifest, pages } = buildViewManifest(analysis, 2);
    const { detailFacts } = buildViewManifest(analysis, 2);
    const first = manifest.views[0].pages[0];
    const tampered = {
      ...manifest,
      views: manifest.views.map((view, index) => index === 0 ? { ...view, pages: [{ ...first, nodeIds: [...first.nodeIds, "missing:node"] }] } : view),
    };
    expect(validateViewManifest(tampered, pages, analysis.evidence.records).missingFactIds).toContain("missing:node");
    const duplicate = {
      ...manifest,
      views: manifest.views.map((view, index) => index === 0 ? { ...view, pages: [...view.pages, { ...first, entities: first.entities.map((entity) => ({ ...entity, aliasOf: undefined })) }] } : view),
    };
    expect(validateViewManifest(duplicate, pages, analysis.evidence.records).duplicateFactIds.length).toBeGreaterThan(0);
    const dangling = {
      ...manifest,
      views: manifest.views.map((view, index) => index === 0 ? { ...view, pages: [{ ...first, entities: first.entities.map((entity, entityIndex) => entityIndex === 0 ? { ...entity, evidenceIds: ["ev:missing"] } : entity) }] } : view),
    };
    expect(validateViewManifest(dangling, pages, analysis.evidence.records).danglingEvidenceIds).toContain("ev:missing");
    expect(evaluateArchitectureViews(analysis, { viewManifest: manifest, viewPages: pages, viewDetails: detailFacts }).fullArchitecture).toBe(true);
    expect(evaluateArchitectureViews(analysis, { viewManifest: tampered, viewPages: pages, viewDetails: detailFacts }).fullArchitecture).toBe(false);
  });

  it("bounds detail pages and preserves every aggregated source edge exactly once", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { manifest, pages } = buildViewManifest(analysis, 2);
    expect(manifest.roundtrip.ok).toBe(true);
    for (const page of pages.filter((candidate) => candidate.kind !== "overview")) {
      expect(page.facts.nodes.length).toBeLessThanOrEqual(2);
    }
    const moduleViews = manifest.views.filter((candidate) => candidate.kind === "modules");
    expect(moduleViews.some((view) => view.pages.some((page) => page.entities.some((entity) => entity.aggregateOf)))).toBe(true);
    for (const view of moduleViews) {
      const originalIds = view.pages.flatMap((page) => page.entities.flatMap((entity) => entity.aggregateOf ?? []));
      if (originalIds.length === 0) continue;
      expect(new Set(originalIds).size).toBe(originalIds.length);
      expect(view.pages.some((page) => page.entities.some((entity) => entity.aggregateOf?.length === 1))).toBe(true);
    }
    for (const view of manifest.views) {
      for (const page of view.pages) {
        for (const entity of page.entities) {
          expect([...entity.representativeEvidenceIds, ...entity.remainingEvidenceIds]).toEqual(entity.evidenceIds);
        }
      }
    }
  });

  it("lays out dense fan-out without dropping connections or producing non-finite labels", () => {
    const components: ArchitectureDocument["components"] = [
      { id: "source", type: "backend", label: "source", sublabel: "api", pos: [Number.NaN, Number.NaN], size: [180, 64] },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `target-${index}`, type: "external" as const, label: `target ${index}`, sublabel: "external", pos: [Number.NaN, Number.NaN] as [number, number], size: [180, 64] as [number, number] })),
    ];
    const connections = Array.from({ length: 48 }, (_, index) => ({ id: `call-${index}`, from: "source", to: `target-${index % 12}`, label: `call operation-${index}` }));
    const routed = layoutArchitecture(components, connections, new Map(components.map((component) => [component.id, component.id === "source" ? "api" : "external"])), new Set(["source"]));
    expect(routed.connections).toHaveLength(48);
    expect(routed.connections.every((connection) => connection.labelAt?.every((value) => Number.isFinite(value)))).toBe(true);
    expect(routed.viewBox.every((value) => Number.isFinite(value))).toBe(true);
  });
});
