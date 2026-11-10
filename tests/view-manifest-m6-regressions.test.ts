import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSources } from "../src/core/analyze.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { buildViewManifest, validateViewManifest } from "../src/core/architecture/view-manifest.js";
import { evidenceIdsFor } from "../src/core/architecture/evidence-index.js";
import { buildArchitectureIr } from "../src/core/architecture/ir.js";
import { evaluateArchitectureViews } from "../src/core/architecture/coverage-matrix.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const sources = [
  { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
  { path: "app/page.tsx", content: 'import { getProducts } from "../lib/shopify";\nexport default async function Page() { await getProducts(); }' },
  { path: "app/api/products/route.ts", content: 'export async function GET() { return Response.json({ ok: true }); }' },
  { path: "lib/shopify/index.ts", content: 'const endpoint = "https://api.example.com/graphql";\nexport async function getProducts() { return fetch(endpoint, { method: "POST", body: `query getProducts { products { id } }` }); }' },
];

describe("M6 manifest regression boundaries", () => {
  it("rejects removed views/pages and valid-but-wrong evidence substitutions", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { manifest, pages } = buildViewManifest(analysis, 2);
    const withoutView = { ...manifest, views: manifest.views.slice(1) };
    expect(validateViewManifest(withoutView, pages, analysis.evidence.records).ok).toBe(false);
    const firstView = manifest.views[0];
    const withoutPage = { ...manifest, views: manifest.views.map((view, index) => index === 0 ? { ...view, pages: view.pages.slice(1) } : view) };
    expect(validateViewManifest(withoutPage, pages, analysis.evidence.records).ok).toBe(false);
    const firstPage = firstView.pages[0];
    const firstEntity = firstPage.entities[0];
    const wrongEvidence = analysis.evidence.records.find((record) => !firstEntity.evidenceIds.includes(record.id));
    expect(wrongEvidence).toBeDefined();
    const substituted = {
      ...manifest,
      views: manifest.views.map((view, index) => index === 0 ? {
        ...view,
        pages: view.pages.map((page, pageIndex) => pageIndex === 0 ? {
          ...page,
          entities: page.entities.map((entity, entityIndex) => entityIndex === 0 ? { ...entity, evidenceIds: [wrongEvidence!.id], representativeEvidenceIds: [wrongEvidence!.id], remainingEvidenceIds: [] } : entity),
        } : page),
      } : view),
    };
    expect(validateViewManifest(substituted, pages, analysis.evidence.records).ok).toBe(false);
  });

  it("keeps config-binding operations with the runtime flow that owns their primary operation", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "example.com/demo/internal/clients/payments"\nfunc main() { payments.Sync() }' },
      { path: "internal/clients/payments/client.go", content: 'package payments\nimport ("net/http"; "os")\nfunc Sync() { http.Get(os.Getenv("PAYMENTS_API_URL")) }' },
    ]);
    const config = analysis.ir.operations.find((operation) => operation.kind === "config-binding");
    expect(config).toBeDefined();
    const { manifest } = buildViewManifest(analysis, 48);
    const flowOperationIds = manifest.views.filter((view) => view.kind === "flows").flatMap((view) => view.pages.flatMap((page) => page.operationIds));
    expect(flowOperationIds).toContain(config!.id);
  });

  it("writes no-render page JSON and persists the IR/evidence chain", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-m6-no-render-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources,
      sourceReceipt: { scope: "repository", directories: 3, files: sources.length, bytes: 500 },
      outDir,
      requestedViews: ["full"],
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    const manifest = JSON.parse(await readFile(join(outDir, "architecture.views.json"), "utf8"));
    const evidence = JSON.parse(await readFile(join(outDir, "architecture.evidence.json"), "utf8"));
    const ir = JSON.parse(await readFile(join(outDir, "architecture.ir.json"), "utf8"));
    const evidenceIds = new Set(evidence.records.map((record: { id: string }) => record.id));
    const irIds = new Set([...ir.nodes, ...ir.edges, ...ir.operations].map((fact: { id: string }) => fact.id));
    for (const view of manifest.views) {
      const componentIds = new Set<string>();
      const connectionIds = new Set<string>();
      for (const page of view.pages) {
        expect(existsSync(join(outDir, page.json))).toBe(true);
        const spec = JSON.parse(await readFile(join(outDir, page.json), "utf8"));
        for (const component of spec.components) componentIds.add(component.id);
        for (const connection of spec.connections) connectionIds.add(connection.id);
      }
      for (const page of view.pages) {
        for (const entity of page.entities) {
          for (const id of entity.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
          if (!entity.aliasOf) for (const id of entity.irFactIds) expect(irIds.has(id)).toBe(true);
          if (entity.ownerType === "node") expect(componentIds.has(entity.projectionId)).toBe(true);
          if (entity.ownerType === "edge") expect(connectionIds.has(entity.projectionId)).toBe(true);
          if (entity.ownerType === "operation") {
            expect(entity.projectionId).toBeUndefined();
            for (const id of entity.relatedProjectionIds) expect(connectionIds.has(id)).toBe(true);
          }
        }
      }
    }
  });

  it("gives every projected page a unique JSON and HTML path", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { manifest } = buildViewManifest(analysis, 1);
    const paths = manifest.views.flatMap((view) => view.pages.flatMap((page) => [page.json, page.html]));
    expect(new Set(paths).size).toBe(paths.length);
    const overview = manifest.views.find((view) => view.kind === "overview");
    expect(overview?.pages.every((page) => page.nodeIds.length >= 2)).toBe(true);
  });

  it("preserves exact source evidence and canonical internal module identity", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { detailFacts } = buildViewManifest(analysis, 2);
    const sourceEdges = new Map<string, { evidenceIds: string[] }>([
      ...analysis.moduleGraph.edges,
      ...analysis.goModuleGraph.edges,
      ...analysis.routeGraph.edges,
      ...analysis.routeGraph.calls,
      ...analysis.facts.edges.map((edge) => ({ id: edge.id, evidenceIds: evidenceIdsFor(edge.evidence) })),
    ].map((edge) => [edge.id, edge]));
    for (const projection of detailFacts) {
      for (const edge of projection.facts.edges) {
        const source = sourceEdges.get(edge.id);
        if (source) expect(evidenceIdsFor(edge.evidence).sort()).toEqual([...source.evidenceIds].sort());
      }
    }
    const internal = analysis.moduleGraph.edges.find((edge) => edge.toKind === "module");
    expect(internal).toBeDefined();
    const target = detailFacts.filter((projection) => projection.scope === "module-architecture").flatMap((projection) => projection.facts.nodes).find((node) => node.id === internal!.to);
    expect(target).toBeDefined();
    expect(target!.kind).not.toBe("external");
  });

  it("preserves callback direction and never materializes omitted identities", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      sources[0],
      { path: "app/api/webhooks/github/route.ts", content: 'export async function POST(request: Request) {\n const event = request.headers.get("x-github-event"); if (event === "push") return Response.json({ ok: true });\n}' },
      { path: "app/page.tsx", content: "export default async function Page() { await fetch(endpoint); }" },
    ]);
    const { detailFacts } = buildViewManifest(analysis, 48);
    const flowFacts = detailFacts.filter((projection) => projection.scope === "protocol-flows");
    expect(flowFacts.flatMap((projection) => projection.facts.edges).some((edge) => edge.kind === "callback" && edge.from === "external:github" && edge.to === "next:root:api")).toBe(true);
    expect(flowFacts.flatMap((projection) => projection.facts.nodes).some((node) => node.id === "external:unknown")).toBe(false);
  });

  it("projects SQL operations to actual semantic flow edges", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport "example.com/app"\nfunc main() { app.Serve() }' },
      { path: "app.go", content: 'package app\nimport "database/sql"\nfunc init() {\n db, _ = sql.Open("postgres", "dsn")\n db.Query("SELECT id FROM users")\n db.Exec("INSERT INTO users VALUES (1)")\n db.Begin()\n db.Commit()\n}' },
    ]);
    const { manifest, detailFacts } = buildViewManifest(analysis, 48);
    const flowEntities = manifest.views.filter((view) => view.kind === "flows").flatMap((view) => view.pages.flatMap((page) => page.entities));
    const sql = analysis.ir.operations.filter((operation) => operation.kind === "sql" && operation.owner === "go:cmd/app");
    expect(sql.length).toBeGreaterThan(0);
    for (const operation of sql) {
      const entity = flowEntities.find((candidate) => candidate.ownerId === operation.id);
      expect(entity).toBeDefined();
      expect(entity!.projectionId).toBeUndefined();
      expect(entity!.relatedProjectionIds!.length).toBeGreaterThan(0);
    }
    expect(detailFacts.filter((projection) => projection.scope === "protocol-flows").flatMap((projection) => projection.facts.edges).some((edge) => edge.kind === "sql")).toBe(true);
  });

  it("blocks the affected single view when its manifest is tampered", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const { manifest, pages } = buildViewManifest(analysis, 2);
    const tampered = { ...manifest, views: manifest.views.map((view) => view.kind === "modules" ? { ...view, pages: view.pages.slice(1) } : view) };
    const evaluation = evaluateArchitectureViews(analysis, { viewManifest: tampered, viewPages: pages });
    expect(evaluation.views["module-architecture"].status).toBe("failed");
    expect(evaluation.views["runtime-overview"].status).toBe("passed");
    expect(evaluation.fullArchitecture).toBe(false);
  });

  it("uses IR as the denominator when pages and manifest are removed together", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const model = buildViewManifest(analysis, 2);
    const ir = buildArchitectureIr({ revision, view: "runtime-overview", scope: analysis.scope, facts: analysis.facts, evidence: analysis.evidence, declarations: analysis.declarations, census: analysis.census, operations: analysis.ir.operations, additionalFacts: model.detailFacts });
    const removed = model.pages.find((page) => page.kind === "modules")!;
    const reducedPages = model.pages.filter((page) => !(page.kind === removed.kind && page.owner === removed.owner));
    const reducedManifest = { ...model.manifest, views: model.manifest.views.filter((view) => !(view.kind === removed.kind && view.owner === removed.owner)) };
    const evidence = [...new Map([...analysis.evidence.records, ...model.additionalEvidenceRecords].map((record) => [record.id, record])).values()];
    expect(validateViewManifest(reducedManifest, reducedPages, evidence).ok).toBe(false);
    const reconciled = validateViewManifest(reducedManifest, reducedPages, evidence, ir);
    expect(reconciled.ok).toBe(false);
    expect(reconciled.missingFactIds.length).toBeGreaterThan(0);
  });

  it("preserves async fallback evidence IDs and queue/schedule relationships", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport "example.com/app"\nfunc main() { app.Serve() }' },
      { path: "app.go", content: 'package app\nimport ("os"; "os/signal"; "syscall")\nfunc Serve() {\n c := make(chan os.Signal, 2)\n signal.Notify(c, os.Interrupt, syscall.SIGTERM)\n go func() { <-c }()\n}' },
      { path: "jobs.go", content: 'package app\nimport "time"\nfunc jobs() { t := time.NewTicker(time.Second); <-t.C }' },
    ]);
    const async = analysis.ir.operations.filter((operation) => operation.id.startsWith("operation:async:"));
    expect(async.length).toBeGreaterThan(0);
    const { manifest } = buildViewManifest(analysis, 48);
    const flowPages = manifest.views.filter((view) => view.kind === "flows").flatMap((view) => view.pages);
    for (const operation of async) {
      const entity = flowPages.flatMap((page) => page.entities).find((candidate) => candidate.ownerId === operation.id);
      expect(entity!.relatedProjectionIds!.length).toBeGreaterThan(0);
      const edge = flowPages.flatMap((page) => page.entities).find((candidate) => candidate.projectionId === entity!.relatedProjectionIds![0]);
      expect(edge).toBeDefined();
      expect(edge!.evidenceIds).toEqual(expect.arrayContaining(operation.evidenceIds));
    }
  });

  it("blocks operations that have no runtime flow owner", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"node src/jobs/render.ts"}}' },
      { path: "src/jobs/render.ts", content: "setInterval(() => { console.log('render'); }, 1000);" },
    ]);
    expect(analysis.ir.operations.some((operation) => operation.kind === "schedule")).toBe(true);
    const model = buildViewManifest(analysis, 48);
    const evaluation = evaluateArchitectureViews(analysis, { viewManifest: model.manifest, viewPages: model.pages, viewDetails: model.detailFacts });
    expect(evaluation.views["protocol-flows"].status).toBe("failed");
    expect(evaluation.views["protocol-flows"].blockingReasons.join(" ")).toContain("no protocol flow owner");
    expect(evaluation.fullArchitecture).toBe(false);
  });

  it("assigns frontend package operations without exact entrypoint closure", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "web/package.json", content: '{"scripts":{"dev":"vite"},"dependencies":{"vite":"7.0.0","react":"19.0.0"}}' },
      { path: "web/vite.config.ts", content: "export default {};" },
      { path: "web/src/index.tsx", content: 'import App from "./App";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<App/>);' },
      { path: "web/src/App.tsx", content: 'import { NotificationBar } from "./components/NotificationBar";\nexport default function App() { return <NotificationBar/>; }' },
      { path: "web/src/components/NotificationBar.tsx", content: "export function NotificationBar() { setInterval(() => console.log('notify'), 1000); }" },
    ]);
    const operation = analysis.ir.operations.find((candidate) => candidate.kind === "schedule" && candidate.callSite?.includes("NotificationBar"));
    expect(operation).toBeDefined();
    const model = buildViewManifest(analysis, 48);
    const flowIds = model.detailFacts.filter((projection) => projection.scope === "protocol-flows").flatMap((projection) => projection.operations.map((candidate) => candidate.id));
    expect(flowIds).toContain(operation!.id);
  });

  it("does not assign an unreferenced same-package job to the frontend", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "web/package.json", content: '{"scripts":{"dev":"vite"},"dependencies":{"vite":"7.0.0","react":"19.0.0"}}' },
      { path: "web/vite.config.ts", content: "export default {};" },
      { path: "web/src/index.tsx", content: 'import App from "./App";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<App/>);' },
      { path: "web/src/App.tsx", content: "export default function App() { return null; }" },
      { path: "web/src/jobs/render.ts", content: "setInterval(() => console.log('render'), 1000);" },
    ]);
    const operation = analysis.ir.operations.find((candidate) => candidate.kind === "schedule" && candidate.callSite?.includes("jobs/render"));
    expect(operation).toBeDefined();
    const model = buildViewManifest(analysis, 48);
    const flowIds = model.detailFacts.filter((projection) => projection.scope === "protocol-flows").flatMap((projection) => projection.operations.map((candidate) => candidate.id));
    expect(flowIds).not.toContain(operation!.id);
    const evaluation = evaluateArchitectureViews(analysis, { viewManifest: model.manifest, viewPages: model.pages, viewDetails: model.detailFacts });
    expect(evaluation.views["protocol-flows"].status).toBe("failed");
  });

  it("rejects deleting flows even when overview shares the same base facts", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const model = buildViewManifest(analysis, 2);
    const ir = buildArchitectureIr({ revision, view: "runtime-overview", scope: analysis.scope, facts: analysis.facts, evidence: analysis.evidence, declarations: analysis.declarations, census: analysis.census, operations: analysis.ir.operations, additionalFacts: model.detailFacts });
    const reducedPages = model.pages.filter((page) => page.kind !== "flows");
    const reducedManifest = { ...model.manifest, views: model.manifest.views.filter((view) => view.kind !== "flows") };
    const evidence = [...new Map([...analysis.evidence.records, ...model.additionalEvidenceRecords].map((record) => [record.id, record])).values()];
    const reconciled = validateViewManifest(reducedManifest, reducedPages, evidence, ir, model.detailFacts);
    expect(reconciled.ok).toBe(false);
    expect(reconciled.missingFactIds.some((id) => id.startsWith("flows:"))).toBe(true);
    expect(validateViewManifest(reducedManifest, reducedPages, evidence, ir).ok).toBe(false);
    const ownersAlsoRemoved = { ...reducedManifest, detailOwners: reducedManifest.detailOwners.filter((projection) => projection.scope !== "protocol-flows") };
    expect(validateViewManifest(ownersAlsoRemoved, reducedPages, evidence, ir).ok).toBe(false);
    const withoutOwnership = { ...reducedManifest, detailOwners: undefined } as unknown as typeof reducedManifest;
    expect(validateViewManifest(withoutOwnership, reducedPages, evidence, ir).ok).toBe(false);
    expect(validateViewManifest(withoutOwnership, reducedPages, evidence, { ...ir, viewOwners: [] }).missingFactIds).toContain("detail-ownership-required");
    const evaluation = evaluateArchitectureViews(analysis, { viewManifest: reducedManifest, viewPages: reducedPages, viewDetails: model.detailFacts });
    expect(evaluation.views["protocol-flows"].status).toBe("failed");
  });

  it("rejects conflicting same-ID IR facts instead of first-wins merging", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const original = analysis.facts.nodes[0];
    const kind = original.kind === "api" ? "frontend" as const : "api" as const;
    expect(() => buildArchitectureIr({
      revision,
      view: "runtime-overview",
      scope: analysis.scope,
      facts: analysis.facts,
      evidence: analysis.evidence,
      declarations: analysis.declarations,
      census: analysis.census,
      operations: analysis.ir.operations,
      additionalFacts: [{ scope: "module-architecture", facts: { version: 1, revision, roots: [original.id], nodes: [{ ...original, kind }], edges: [], omissions: [] } }],
    })).toThrow(/Conflicting IR node kind/);
  });
});
