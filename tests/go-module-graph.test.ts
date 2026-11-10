import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { buildSourceCensus } from "../src/core/architecture/census.js";
import { createUnavailableAdapter, projectPreparationSchema } from "../src/core/architecture/project/adapter.js";
import { buildGoModuleGraph, goModuleGraphEvidenceReferences } from "../src/core/architecture/project/go-module-graph.js";
import { goParserStatus, parseGoSource } from "../src/core/architecture/project/go-parser.js";
import { prepareProjects } from "../src/core/architecture/project/prepare.js";
import { createSourceSnapshot, numberedText } from "../src/core/architecture/project/snapshot.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { revision } from "./helpers.js";

function source(path: string, raw: string) {
  return { path, content: numberedText(raw), rawText: () => raw };
}

/** Mirror the project-preparation test helper, plus a direct Go package graph build. */
function goGraph(files: Record<string, string>, overrides: Partial<Parameters<typeof prepareProjects>[0]> = {}) {
  const sources = Object.entries(files).map(([path, raw]) => source(path, raw));
  const census = buildSourceCensus({
    revision,
    inventory: sources.map((item) => ({ path: item.path, size: 0, entryKind: "file" as const, selected: true })),
  });
  const snapshot = createSourceSnapshot({ revision, sources, census });
  const project = prepareProjects({ revision, snapshot, census, ...overrides });
  const graph = buildGoModuleGraph({ revision, snapshot, census, project });
  return { snapshot, census, project, graph };
}

describe("M2 go-module-graph: fixed WASM parser runtime", () => {
  it("parses real Go syntax with a bundled grammar", () => {
    expect(goParserStatus().status).toBe("available");
    const parsed = parseGoSource('package main\n\nimport (\n  "fmt"\n  _ "github.com/lib/pq"\n)\n\nfunc main() { fmt.Println("x") }\n');
    expect(parsed?.packageName).toBe("main");
    expect(parsed?.imports.map((item) => item.source)).toEqual(["fmt", "github.com/lib/pq"]);
    expect(parsed?.imports[1].form).toBe("blank");
    expect(parsed?.symbols.map((item) => item.name)).toContain("main");
    expect(parsed?.callExpressions).toBe(1);
    expect(parsed?.diagnostics).toHaveLength(0);
  });
});

describe("M2 go-module-graph: go.mod resolution and internal package edges", () => {
  it("builds one package node per directory and an internal edge inside the module", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n\ngo 1.22\n",
      "main.go": "package main\n\nimport \"example.com/svc/internal/store\"\n\nfunc main() { _ = store.Value }\n",
      "internal/store/store.go": "package store\n\nvar Value = 1\n",
    });
    expect(graph.nodes.map((node) => node.importPath).sort()).toEqual([
      "example.com/svc", "example.com/svc/internal/store",
    ]);
    const main = graph.nodes.find((node) => node.packageName === "main");
    const store = graph.nodes.find((node) => node.packageName === "store");
    expect(main).toBeDefined();
    expect(store).toBeDefined();
    const edge = graph.edges.find((item) => item.from === main?.id && item.to === store?.id);
    expect(edge?.resolution).toBe("go-module-internal");
    expect(edge?.toKind).toBe("package");
    expect(edge?.crossModule).toBe(false);
    expect(graph.gates.runtimeOverviewUnaffected).toBe(true);
  });
});

describe("M2 go-module-graph: standard-library and external classification", () => {
  it("separates standard-library and external packages without mislabelling them unresolved", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n\ngo 1.22\n",
      "main.go": [
        "package main",
        'import (',
        '  "fmt"',
        '  "net/http"',
        '  _ "github.com/lib/pq"',
        ")",
        "func main() { fmt.Println(http.Get) }\n",
      ].join("\n"),
    });
    expect(graph.standardPackages.map((item) => item.name).sort()).toEqual(["fmt", "net/http"]);
    expect(graph.externalModules.map((item) => item.name)).toEqual(["github.com/lib/pq"]);
    expect(graph.edges.filter((item) => item.toKind === "standard-library")).toHaveLength(2);
    expect(graph.edges.filter((item) => item.toKind === "external")).toHaveLength(1);
    expect(graph.statistics.standardLibraryEdges).toBe(2);
    expect(graph.statistics.externalEdges).toBe(1);
    expect(graph.unresolvedImports).toHaveLength(0);
    // Neither set blocks the module view on its own.
    expect(graph.gates.blockedViews).not.toContain("module-architecture");
    expect(graph.gates.runtimeOverviewUnaffected).toBe(true);
  });
});

describe("M2 go-module-graph: explicit build-context file selection", () => {
  it("excludes GOOS/GOARCH-suffixed and build-tagged files by default, and includes them under a matching context", () => {
    const files = {
      "go.mod": "module example.com/svc\n\ngo 1.22\n",
      "main.go": "package main\n\nfunc main() {}\n",
      "os_windows.go": "package main\n\nfunc windowsOnly() {}\n",
      "tagged_linux.go": "//go:build linux && amd64\n\npackage main\n\nfunc tagged() {}\n",
      "disabled.go": "//go:build windows\n\npackage main\n\nfunc disabled() {}\n",
    };
    const base = goGraph(files);
    const excludedPaths = base.graph.excludedFiles.map((item) => item.path).sort();
    expect(excludedPaths).toEqual(["disabled.go", "os_windows.go"]);
    expect(base.graph.statistics.parsedFiles).toBe(2); // main.go + tagged_linux.go

    const windows = goGraph(files, {
      buildContext: { goos: "windows", goarch: "amd64", buildTags: [] },
    });
    expect(windows.graph.excludedFiles.map((item) => item.path).sort()).toEqual(["tagged_linux.go"]);
    expect(windows.graph.statistics.parsedFiles).toBe(3); // main.go + os_windows.go + disabled.go
  });
});

describe("M2 go-module-graph: go.work workspace and cross-module edges", () => {
  it("resolves cross-module imports inside a workspace and records uses", () => {
    const { graph } = goGraph({
      "go.work": "go 1.22\n\nuse (\n  ./svc\n  ./core\n)\n",
      "svc/go.mod": "module example.com/svc\n\ngo 1.22\n",
      "svc/main.go": "package main\n\nimport \"example.com/core\"\n\nfunc main() { _ = core.X }\n",
      "core/go.mod": "module example.com/core\n\ngo 1.22\n",
      "core/core.go": "package core\n\nvar X = 1\n",
    });
    expect(graph.modules.map((module) => module.modulePath).sort()).toEqual(["example.com/core", "example.com/svc"]);
    expect(graph.workspaces.flatMap((workspace) => workspace.uses).sort()).toEqual(["./core", "./svc"]);
    const crossEdge = graph.edges.find((item) => item.crossModule);
    expect(crossEdge?.resolution).toBe("go-workspace-module");
    expect(graph.statistics.crossModuleEdges).toBe(1);
    expect(graph.resolutionRules.workspaceUses).toEqual(["./core", "./svc"]);
  });
});

describe("M2 go-module-graph: replace directives", () => {
  it("redirects a replaced module to a local package inside the snapshot", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n\nreplace example.com/x => ./x\n",
      "main.go": "package main\n\nimport \"example.com/x\"\n\nfunc main() { _ = x.Y }\n",
      "x/x.go": "package x\n\nvar Y = 1\n",
    });
    expect(graph.resolutionRules.localReplaces).toContainEqual({ from: "example.com/x", to: "./x" });
    const replacedEdge = graph.edges.find((item) => item.source === "example.com/x");
    expect(replacedEdge?.resolution).toBe("go-replace-local");
    expect(replacedEdge?.toKind).toBe("package");
  });
});

describe("M2 go-module-graph: cycles are preserved", () => {
  it("keeps an import cycle as an explicit cycle set rather than dropping edges", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n",
      "a/a.go": "package a\n\nimport \"example.com/svc/b\"\n\nvar A = b.B\n",
      "b/b.go": "package b\n\nimport \"example.com/svc/a\"\n\nvar B = a.A\n",
    });
    expect(graph.cycles.length).toBeGreaterThanOrEqual(1);
    expect(graph.cycles[0].nodes.sort()).toEqual(["go-package:a:a", "go-package:b:b"]);
  });
});

describe("M2 go-module-graph: syntax errors block the module view, not the pipeline", () => {
  it("records parse-error omissions and blocks module-architecture while leaving runtime-overview unaffected", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n",
      "broken.go": "package main\n\nfunc main( { }\n",
    });
    expect(graph.parser.status).toBe("available");
    expect(graph.gates.blockedViews).toContain("module-architecture");
    expect(graph.gates.blockedViews).not.toContain("runtime-overview");
    expect(graph.gates.runtimeOverviewUnaffected).toBe(true);
    expect(graph.omissions.some((omission) => omission.reason === "parse-error")).toBe(true);
  });
});

describe("M2 go-module-graph: parser-unavailable degradation", () => {
  it("produces go build context and an independent denominator but no package graph when the Go adapter is unavailable", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n",
      "main.go": "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"x\") }\n",
    }, { adapters: [createUnavailableAdapter("ast-go", ["go"], "simulated missing grammar")] });
    expect(graph.nodes).toHaveLength(0);
    expect(graph.gates.runtimeOverviewUnaffected).toBe(true);
    expect(graph.gates.blockedViews).toContain("module-architecture");
    // The independent line-scan denominator still exists and now reports everything as missing.
    expect(graph.importDeclarations.expected).toBeGreaterThan(0);
    expect(graph.importDeclarations.missing.length).toBe(graph.importDeclarations.expected);
    expect(graph.omissions.some((omission) => omission.reason === "parser-unavailable")).toBe(true);
  });
});

describe("M2 go-module-graph: independent import denominator (mutation proof)", () => {
  it("matches AST edges to the independent scan with the real adapter, and survives AST extraction being disabled", () => {
    const files = {
      "go.mod": "module example.com/svc\n",
      "main.go": "package main\n\nimport (\n  \"fmt\"\n  \"example.com/svc/x\"\n)\n\nfunc main() { fmt.Println(x.V) }\n",
      "x/x.go": "package x\n\nvar V = 1\n",
    };
    const real = goGraph(files);
    expect(real.graph.importDeclarations.missing).toHaveLength(0);
    expect(real.graph.importDeclarations.expected).toBe(real.graph.importDeclarations.observed);

    const disabled = goGraph(files, { adapters: [createUnavailableAdapter("ast-go", ["go"], "simulated missing grammar")] });
    // Denominator is independent: the same expected count, but every declaration now lacks an AST edge.
    expect(disabled.graph.importDeclarations.expected).toBe(real.graph.importDeclarations.expected);
    expect(disabled.graph.importDeclarations.missing.length).toBe(disabled.graph.importDeclarations.expected);
  });
});

describe("M2 go-module-graph: evidence reconciliation", () => {
  it("keeps every AST edge evidence id in the graph index and the projection references", () => {
    const { graph } = goGraph({
      "go.mod": "module example.com/svc\n",
      "main.go": "package main\n\nimport \"example.com/svc/x\"\n\nfunc main() { _ = x.V }\n",
      "x/x.go": "package x\n\nvar V = 1\n",
    });
    const indexedIds = new Set(graph.evidenceRecords.map((record) => record.id));
    for (const edge of graph.edges) {
      for (const id of edge.evidenceIds) expect(indexedIds.has(id)).toBe(true);
    }
    const refs = goModuleGraphEvidenceReferences(graph);
    expect(refs).toHaveLength(graph.edges.length);
    expect(refs.every((ref) => ref.ownerType === "go-module-edge")).toBe(true);
    for (const ref of refs) for (const id of ref.evidenceIds) expect(indexedIds.has(id)).toBe(true);
  });
});

describe("M2 go-module-graph: end-to-end delivery", () => {
  it("emits architecture.go-module-graph.json from the real local loader without changing facts v1", async () => {
    const root = await mkdtemp(join(tmpdir(), "repomap-go-e2e-"));
    await mkdir(join(root, "cmd/e2e"), { recursive: true });
    await mkdir(join(root, "internal/store"), { recursive: true });
    await writeFile(join(root, "go.mod"), "module example.com/e2e\n\ngo 1.22\n");
    await writeFile(join(root, "cmd/e2e/main.go"), "package main\n\nimport \"example.com/e2e/internal/store\"\n\nfunc main() { _ = store.V }\n");
    await writeFile(join(root, "internal/store/store.go"), "package store\n\nvar V = 1\n");
    const loaded = await loadLocalRepositorySources(root);
    const outDir = await mkdtemp(join(tmpdir(), "repomap-go-out-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: loaded.sources,
      inventory: loaded.inventory,
      sourceReceipt: loaded.receipt,
      outDir,
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    const project = JSON.parse(await readFile(join(outDir, "architecture.project.json"), "utf8"));
    projectPreparationSchema.parse(project);
    expect(project.parsers.find((parser: { id: string }) => parser.id === "ast-go")?.status).not.toBe("unavailable");
    const goGraphJson = JSON.parse(await readFile(join(outDir, "architecture.go-module-graph.json"), "utf8"));
    expect(goGraphJson.parser.status).toBe("available");
    expect(goGraphJson.nodes.length).toBeGreaterThan(0);
    expect(goGraphJson.gates.runtimeOverviewUnaffected).toBe(true);
    const facts = JSON.parse(await readFile(join(outDir, "architecture.facts.json"), "utf8"));
    expect(facts.version).toBe(1);
    expect(JSON.stringify(facts)).not.toContain("evidenceIds");
  });
});
