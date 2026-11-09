import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { buildSourceCensus } from "../src/core/architecture/census.js";
import { createSourceSnapshot, numberedText } from "../src/core/architecture/project/snapshot.js";
import { createUnavailableAdapter, projectPreparationSchema } from "../src/core/architecture/project/adapter.js";
import { prepareProjects, viewsBlockedByPreparation } from "../src/core/architecture/project/prepare.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

function source(path: string, raw: string) {
  return { path, content: numberedText(raw), rawText: () => raw };
}

function prepared(files: Record<string, string>, overrides: Partial<Parameters<typeof prepareProjects>[0]> = {}) {
  const sources = Object.entries(files).map(([path, raw]) => source(path, raw));
  const census = buildSourceCensus({
    revision,
    inventory: sources.map((item) => ({ path: item.path, size: 0, entryKind: "file" as const, selected: true })),
  });
  const snapshot = createSourceSnapshot({ revision, sources, census });
  return { snapshot, census, project: prepareProjects({ revision, snapshot, census, ...overrides }) };
}

describe("M2 project preparation: immutable raw snapshot", () => {
  it("keeps parser input separate from the numbered evidence view", () => {
    const raw = "export const n = 1;\n// 12: this is not a line number\n";
    const { snapshot } = prepared({ "src/a.ts": raw });
    expect(snapshot.rawText("src/a.ts")).toBe(raw);
    expect(snapshot.numberedText("src/a.ts")).toContain("1: export const n = 1;");
    expect(snapshot.numberedText("src/a.ts")).toContain("2: // 12: this is not a line number");
    expect(snapshot.lineForOffset("src/a.ts", raw.indexOf("//"))).toBe(2);
    expect(snapshot.files[0].sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(snapshot.snapshotId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("content-addresses the snapshot so identical raw input is stable and a byte change is not", () => {
    const first = prepared({ "src/a.ts": "export const a = 1;\n" });
    const same = prepared({ "src/a.ts": "export const a = 1;\n" });
    const changed = prepared({ "src/a.ts": "export const a = 2;\n" });
    expect(first.snapshot.snapshotId).toBe(same.snapshot.snapshotId);
    expect(first.snapshot.snapshotId).not.toBe(changed.snapshot.snapshotId);
  });

  it("records explicit build context and go.work/go.mod directives without inheriting host defaults", () => {
    const previousGoos = process.env.GOOS;
    const previousGoarch = process.env.GOARCH;
    process.env.GOOS = "darwin";
    process.env.GOARCH = "arm64";
    try {
      const { project } = prepared({
        "go.work": "go 1.22\nuse ./svc\n",
        "svc/go.mod": "module example.com/svc\nreplace example.com/x => ../x\n",
        "svc/main.go": "package main\nfunc main() {}\n",
      });
      expect(project.buildContext.goos).toBe("linux");
      expect(project.buildContext.goarch).toBe("amd64");
      expect(project.buildContext.buildTags).toEqual([]);
      expect(project.buildContext.workspaces).toContain("go.work:use:./svc");
      expect(project.buildContext.replaces).toContain("svc/go.mod:example.com/x=>../x");
      expect(project.buildContext.workspaces).toContain("package:svc");
    } finally {
      if (previousGoos === undefined) delete process.env.GOOS; else process.env.GOOS = previousGoos;
      if (previousGoarch === undefined) delete process.env.GOARCH; else process.env.GOARCH = previousGoarch;
    }
  });
});

describe("M2 project preparation: project units and TypeScript Program", () => {
  it("keeps same-named modules in different workspaces in distinct units", () => {
    const { project } = prepared({
      "web/package.json": "{\"name\":\"web\"}",
      "api/package.json": "{\"name\":\"api\"}",
      "web/src/index.ts": "import { x } from './x';\nexport const y = x;\n",
      "web/src/x.ts": "export const x = 1;\n",
      "api/src/index.ts": "export const main = 1;\n",
    });
    const units = project.units.filter((unit) => unit.adapterId === "ast-typescript");
    expect(units.map((unit) => unit.packageId).sort()).toEqual(["package:api", "package:web"]);
    expect(new Set(units.map((unit) => unit.id)).size).toBe(2);
    const web = units.find((unit) => unit.packageId === "package:web");
    const api = units.find((unit) => unit.packageId === "package:api");
    expect(web?.files).toContain("web/src/index.ts");
    expect(api?.files).toContain("api/src/index.ts");
    expect(web?.files).not.toContain("api/src/index.ts");
    expect(web?.manifests).toContain("web/package.json");
  });

  it("extracts static/re-export/dynamic/require imports and honest unresolved refs", () => {
    const { project } = prepared({
      "src/index.ts": [
        "import { a } from './a';",
        "export * from './b';",
        "const lazy = () => import('./c');",
        "const legacy = require('lodash');",
        "export const top = a;",
        "",
      ].join("\n"),
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
    });
    const kinds = project.imports.map((item) => item.kind);
    expect(kinds).toContain("static");
    expect(kinds).toContain("re-export");
    expect(kinds).toContain("dynamic");
    expect(kinds).toContain("require");
    expect(project.imports.filter((item) => item.resolvedPath).map((item) => item.resolvedPath).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(project.unresolvedImports.find((item) => item.source === "lodash")?.unresolvedReason).toContain("external-package");
    expect(project.symbols.some((item) => item.name === "top" && item.exported)).toBe(true);
    expect(project.entrypoints.some((item) => item.path === "src/index.ts" && item.kind === "barrel-or-index")).toBe(true);
    expect(project.statistics.imports).toBe(4);
  });

  it("records circular dependencies and missing relative imports instead of dropping them", () => {
    const { project } = prepared({
      "src/a.ts": "import { b } from './b';\nexport const a = b;\n",
      "src/b.ts": "import { a } from './a';\nexport const b = a;\n",
      "src/c.ts": "import { missing } from './missing';\n",
    });
    expect(project.imports.find((item) => item.path === "src/a.ts")?.resolvedPath).toBe("src/b.ts");
    expect(project.imports.find((item) => item.path === "src/b.ts")?.resolvedPath).toBe("src/a.ts");
    expect(project.unresolvedImports.find((item) => item.source === "./missing")?.unresolvedReason).toBe("relative-import-not-resolved-in-snapshot");
    expect(project.statistics.unresolvedImports).toBe(1);
  });

  it("reports syntax errors as parse errors without failing the pipeline", () => {
    const { project } = prepared({ "src/broken.ts": "export const = ;\n" });
    expect(project.parseErrors.some((item) => item.path === "src/broken.ts")).toBe(true);
    expect(project.units.some((unit) => unit.status === "prepared")).toBe(true);
    projectPreparationSchema.parse(project);
  });
});

describe("M2 project preparation: parser gating", () => {
  it("parser-unavailable only blocks parser-dependent views, never runtime-overview", () => {
    const adapters = [
      createUnavailableAdapter("ast-typescript", ["typescript", "javascript"], "simulated missing compiler"),
      createUnavailableAdapter("ast-go", ["go"], "simulated missing helper"),
    ];
    const { project } = prepared({
      "src/a.ts": "export const a = 1;\n",
      "svc/main.go": "package main\nfunc main() {}\n",
    }, { adapters });
    expect(project.units.every((unit) => unit.status === "parser-unavailable")).toBe(true);
    expect(project.statistics.imports).toBe(0);
    expect(project.parsers.find((parser) => parser.id === "ast-typescript")?.status).toBe("unavailable");
    expect(viewsBlockedByPreparation(project)).toContain("module-architecture");
    expect(viewsBlockedByPreparation(project)).not.toContain("runtime-overview");
    expect(project.gates.runtimeOverviewUnaffected).toBe(true);
    expect(project.omissions.every((omission) => !omission.affectedViews.includes("runtime-overview"))).toBe(true);
    expect(project.omissions.every((omission) => omission.reason === "parser-unavailable")).toBe(true);
  });

  it("declares unsupported languages with no adapter as explicit omissions", () => {
    const { project } = prepared({ "lib/tool.py": "def main():\n    pass\n" }, { adapters: [] });
    expect(project.units.some((unit) => unit.status === "no-adapter")).toBe(true);
    expect(project.omissions.some((omission) => omission.reason === "unsupported-language" && omission.detail.includes("python"))).toBe(true);
    expect(project.gates.blockedViews).toContain("module-architecture");
    expect(project.gates.blockedViews).not.toContain("runtime-overview");
  });
});

describe("M2 project preparation: delivery integration", () => {
  it("writes architecture.project.json from the real local loader and keeps facts v1 unchanged", async () => {
    const root = await nextFixture();
    const loaded = await loadLocalRepositorySources(root);
    const outDir = await mkdtemp(join(tmpdir(), "repomap-project-"));
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
    expect(receipt.outputs.project).toContain("architecture.project.json");
    expect(existsSync(join(outDir, "architecture.project.json"))).toBe(true);
    const project = JSON.parse(await readFile(join(outDir, "architecture.project.json"), "utf8"));
    expect(projectPreparationSchema.parse(project).snapshotId).toBe(receipt.project.snapshotId);
    expect(project.units.some((unit: { status: string }) => unit.status === "prepared")).toBe(true);
    expect(receipt.declaredScope.parsers.find((parser: { id: string }) => parser.id === "ast-typescript")?.status).toBe("partial");
    expect(receipt.project.blockedViews).not.toContain("runtime-overview");
    const facts = JSON.parse(await readFile(join(outDir, "architecture.facts.json"), "utf8"));
    expect(facts.version).toBe(1);
    expect(JSON.stringify(facts)).not.toContain("evidenceIds");
    expect(JSON.stringify(facts)).not.toContain("snapshotId");
  });

  it("ships the TypeScript parser as a production dependency, not a dev-only assumption", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies.typescript).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeUndefined();
    expect(pkg.scripts["pack:dry-run"]).toContain("npm pack --dry-run");
    expect(pkg.scripts["smoke:production"]).toBeDefined();
  });
});
