import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { buildSourceCensus } from "../src/core/architecture/census.js";
import { capabilityGaps, repomapCapabilities } from "../src/core/architecture/scope.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { createUnavailableAdapter } from "../src/core/architecture/project/adapter.js";
import { buildModuleGraph, moduleGraphSchema } from "../src/core/architecture/project/module-graph.js";
import { prepareProjects } from "../src/core/architecture/project/prepare.js";
import { createSourceSnapshot, numberedText } from "../src/core/architecture/project/snapshot.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

function source(path: string, raw: string) {
  return { path, content: numberedText(raw), rawText: () => raw };
}

function graph(files: Record<string, string>, overrides: Partial<Parameters<typeof prepareProjects>[0]> = {}) {
  const sources = Object.entries(files).map(([path, raw]) => source(path, raw));
  const census = buildSourceCensus({
    revision,
    inventory: sources.map((item) => ({ path: item.path, size: 0, entryKind: "file" as const, selected: true })),
  });
  const snapshot = createSourceSnapshot({ revision, sources, census });
  const project = prepareProjects({ revision, snapshot, census, ...overrides });
  return { sources, snapshot, census, project, moduleGraph: buildModuleGraph({ revision, snapshot, census, project }) };
}

describe("M2 ts-module-graph: resolution inside the immutable snapshot", () => {
  it("resolves extensionless relatives, directory roots and barrels with evidence", () => {
    const { moduleGraph } = graph({
      "src/index.ts": "import { a } from './a';\nimport { b } from './feature';\nexport * from './shared';\n",
      "src/a.ts": "export const a = 1;\n",
      "src/feature/index.ts": "export const b = 2;\n",
      "src/shared.ts": "export const s = 3;\n",
    });
    const targets = moduleGraph.edges.map((edge) => edge.to);
    expect(targets).toContain("module:package:root:src/a.ts");
    expect(targets).toContain("module:package:root:src/feature/index.ts");
    expect(targets).toContain("module:package:root:src/shared.ts");
    expect(moduleGraph.edges.every((edge) => edge.resolution === "relative")).toBe(true);
    expect(moduleGraph.edges.find((edge) => edge.source === "./feature")?.barrel).toBe(true);
    expect(moduleGraph.edges.every((edge) => edge.evidenceIds.length > 0)).toBe(true);
    expect(moduleGraph.nodes.find((node) => node.path === "src/feature/index.ts")?.kind).toBe("barrel");
    expect(moduleGraph.statistics.modules).toBe(4);
    expect(moduleGraph.statistics.barrelEdges).toBe(1);
  });

  it("honours tsconfig paths and baseUrl instead of treating aliases as external packages", () => {
    const { moduleGraph } = graph({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"], "~/*": ["src/*"] } } }),
      "src/app.ts": "import { x } from '@lib/x';\nimport { y } from '~/y';\n",
      "src/lib/x.ts": "export const x = 1;\n",
      "src/y.ts": "export const y = 2;\n",
    });
    expect(moduleGraph.edges.map((edge) => edge.resolution).sort()).toEqual(["alias", "alias"]);
    expect(moduleGraph.edges.map((edge) => edge.to).sort()).toEqual([
      "module:package:root:src/lib/x.ts", "module:package:root:src/y.ts",
    ]);
    expect(moduleGraph.resolutionRules.tsconfigs[0].paths["@lib/*"]).toEqual(["src/lib/*"]);
    expect(moduleGraph.statistics.aliasEdges).toBe(2);
    expect(moduleGraph.externalPackages).toHaveLength(0);
  });

  it("resolves workspace package names across monorepo packages and keeps same-named modules distinct", () => {
    const { moduleGraph } = graph({
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@mono/core", main: "src/index.ts" }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "packages/ui/package.json": JSON.stringify({ name: "@mono/ui", main: "src/index.ts" }),
      "packages/ui/src/index.ts": "export const ui = 1;\n",
      "apps/web/package.json": JSON.stringify({ name: "@mono/web" }),
      "apps/web/src/app.ts": "import { core } from '@mono/core';\nimport { ui } from '@mono/ui';\n",
    });
    const workspaceEdges = moduleGraph.edges.filter((edge) => edge.resolution === "workspace-package");
    expect(workspaceEdges).toHaveLength(2);
    expect(workspaceEdges.every((edge) => edge.crossPackage)).toBe(true);
    expect(workspaceEdges.map((edge) => edge.to).sort()).toEqual([
      "module:package:packages/core:packages/core/src/index.ts",
      "module:package:packages/ui:packages/ui/src/index.ts",
    ]);
    const ids = moduleGraph.nodes.filter((node) => node.path.endsWith("src/index.ts")).map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    expect(moduleGraph.resolutionRules.workspacePackages.map((entry) => entry.name).sort()).toEqual(["@mono/core", "@mono/ui", "@mono/web", "mono"]);
    expect(moduleGraph.statistics.crossPackageEdges).toBe(2);
  });

  it("keeps workspace edges distinct from project references and external edges", () => {
    const { moduleGraph } = graph({
      "tsconfig.json": JSON.stringify({ references: [{ path: "./packages/core" }] }),
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@mono/core", main: "src/index.ts" }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "src/app.ts": "import { core } from '@mono/core';\nimport lodash from 'lodash';\n",
    });
    expect(moduleGraph.edges.find((edge) => edge.source === "@mono/core")?.resolution).toBe("workspace-package");
    expect(moduleGraph.edges.find((edge) => edge.source === "lodash")?.resolution).toBe("external");
    expect(moduleGraph.edges.find((edge) => edge.source === "lodash")?.toKind).toBe("external");
  });

  it("records tsconfig project references and marks references-resolved edges", () => {
    const { moduleGraph } = graph({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." }, references: [{ path: "./packages/core" }] }),
      "packages/core/package.json": JSON.stringify({ name: "@mono/core" }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "apps/web/package.json": JSON.stringify({ name: "@mono/web" }),
      "apps/web/src/app.ts": "import { core } from '../../../packages/core/src';\n",
    });
    expect(moduleGraph.resolutionRules.tsconfigs[0].references).toContain("packages/core");
    expect(moduleGraph.edges[0].to).toBe("module:package:packages/core:packages/core/src/index.ts");
    expect(moduleGraph.edges[0].resolution).toBe("project-reference");
    expect(moduleGraph.edges[0].crossPackage).toBe(true);
  });

  it("keeps circular dependencies as cycles and never drops an edge", () => {
    const { moduleGraph } = graph({
      "src/a.ts": "import { b } from './b';\nexport const a = b;\n",
      "src/b.ts": "import { a } from './a';\nexport const b = a;\n",
      "src/c.ts": "export const c = 1;\n",
    });
    expect(moduleGraph.edges).toHaveLength(2);
    expect(moduleGraph.cycles).toHaveLength(1);
    expect(moduleGraph.cycles[0].nodes.sort()).toEqual([
      "module:package:root:src/a.ts", "module:package:root:src/b.ts",
    ]);
    expect(moduleGraph.cycles[0].preservesSemantics).toBe(true);
  });

  it("separates external packages from unresolved imports and blocks only parser-dependent views", () => {
    const { moduleGraph } = graph({
      "src/app.ts": "import lodash from 'lodash';\nimport { missing } from './missing';\n",
    });
    expect(moduleGraph.externalPackages.map((entry) => entry.name)).toEqual(["lodash"]);
    expect(moduleGraph.externalPackages[0].reason).toContain("external");
    expect(moduleGraph.unresolvedImports).toHaveLength(1);
    expect(moduleGraph.unresolvedImports[0].source).toBe("./missing");
    const omission = moduleGraph.omissions.find((item) => item.reason === "unresolved-import");
    expect(omission?.blocking).toBe(true);
    expect(omission?.affectedViews).toContain("module-architecture");
    expect(omission?.affectedViews).not.toContain("runtime-overview");
    expect(moduleGraph.gates.runtimeOverviewUnaffected).toBe(true);
    expect(moduleGraph.gates.blockedViews).toContain("module-architecture");
  });

  it("mutation: disabling the AST extractor keeps the independent denominator and blocks the module view", () => {
    const { snapshot, census, project } = graph({
      "src/index.ts": "import { a } from './a';\nexport * from './b';\n",
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    const baseline = buildModuleGraph({ revision, snapshot, census, project });
    expect(baseline.importDeclarations.expected).toBe(2);
    expect(baseline.importDeclarations.missing).toHaveLength(0);

    const disabled = { ...project, imports: [], symbols: [], parseErrors: [] };
    const mutated = buildModuleGraph({ revision, snapshot, census, project: disabled });
    expect(mutated.edges).toHaveLength(0);
    expect(mutated.evidenceRecords).toHaveLength(0);
    expect(mutated.nodes.length).toBeGreaterThan(0);
    expect(mutated.importDeclarations.expected).toBe(baseline.importDeclarations.expected);
    expect(mutated.importDeclarations.missing).toHaveLength(2);
    expect(mutated.gates.blockedViews).toContain("module-architecture");
    expect(mutated.gates.runtimeOverviewUnaffected).toBe(true);
    expect(mutated.omissions.some((omission) => omission.reason === "unsupported-syntax")).toBe(true);
  });

  it("declares an empty graph with explicit parser-unavailable gating when no adapter can parse", () => {
    const adapters = [
      createUnavailableAdapter("ast-typescript", ["typescript", "javascript"], "simulated missing compiler"),
      createUnavailableAdapter("ast-go", ["go"], "simulated missing helper"),
    ];
    const { moduleGraph } = graph({ "src/a.ts": "export const a = 1;\n" }, { adapters });
    expect(moduleGraph.nodes).toHaveLength(0);
    expect(moduleGraph.gates.blockedViews).toContain("module-architecture");
    expect(moduleGraph.gates.runtimeOverviewUnaffected).toBe(true);
    expect(moduleGraph.omissions.some((item) => item.reason === "parser-unavailable")).toBe(true);
  });
});

describe("M2 ts-module-graph: lossless delivery integration", () => {
  it("folds AST import evidence into the single evidence index and reconciles the projection manifest", () => {
    const files = {
      "src/index.ts": "import { a } from './a';\nexport * from './b';\n",
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    };
    const sources = Object.entries(files).map(([path, raw]) => source(path, raw));
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, sources);
    const known = new Set(analysis.evidence.records.map((record) => record.id));
    expect(analysis.moduleGraph.edges.length).toBeGreaterThan(0);
    for (const edge of analysis.moduleGraph.edges) {
      expect(edge.evidenceIds.every((id) => known.has(id))).toBe(true);
    }
    expect(analysis.evidence.records.some((record) => record.source === "parser")).toBe(true);
    expect(analysis.evidence.references.some((reference) => reference.ownerType === "module-edge")).toBe(true);
    expect(analysis.ir.evidenceIndex.total).toBe(analysis.evidence.records.length);
    expect(analysis.projection.totals.hidden).toBe(analysis.evidence.statistics.hiddenEvidenceCount);
    expect(analysis.projection.outputs.map((output) => output.name)).toContain("architecture.module-graph.json");
    expect(JSON.stringify(analysis.facts)).not.toContain("evidenceIds");
    expect(moduleGraphSchema.parse(analysis.moduleGraph).snapshotId).toBe(analysis.snapshotId);
  });

  it("writes architecture.module-graph.json and keeps facts v1 untouched", async () => {
    const root = await nextFixture();
    const loaded = await loadLocalRepositorySources(root);
    const outDir = await mkdtemp(join(tmpdir(), "repomap-module-graph-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: loaded.sources, inventory: loaded.inventory, sourceReceipt: loaded.receipt,
      outDir, render: false, deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.outputs.moduleGraph).toContain("architecture.module-graph.json");
    expect(existsSync(join(outDir, "architecture.module-graph.json"))).toBe(true);
    const written = JSON.parse(await readFile(join(outDir, "architecture.module-graph.json"), "utf8"));
    expect(moduleGraphSchema.parse(written).revision).toBe(revision);
    expect(receipt.moduleGraph.snapshotId).toBe(written.snapshotId);
    const facts = JSON.parse(await readFile(join(outDir, "architecture.facts.json"), "utf8"));
    expect(facts.version).toBe(1);
    expect(JSON.stringify(facts)).not.toContain("evidenceIds");
    expect(JSON.stringify(facts)).not.toContain("moduleGraph");
  });

  it("upgrades the module-graph capability without claiming full architecture", () => {
    const capability = repomapCapabilities.find((entry) => entry.id === "module-graph");
    expect(capability?.status).not.toBe("unavailable");
    expect(capability?.version).toBe("1");
    expect(capabilityGaps()).toContain("module-graph");
    expect(repomapCapabilities.find((entry) => entry.id === "module-graph-go")?.status).toBe("partial");
  });
});
