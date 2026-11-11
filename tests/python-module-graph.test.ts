import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { buildSourceCensus } from "../src/core/architecture/census.js";
import { buildModuleGraph } from "../src/core/architecture/project/module-graph.js";
import { prepareProjects } from "../src/core/architecture/project/prepare.js";
import { createSourceSnapshot, numberedText } from "../src/core/architecture/project/snapshot.js";
import { createUnavailableAdapter } from "../src/core/architecture/project/adapter.js";
import { parsePythonSource, pythonParserStatus } from "../src/core/architecture/project/python-parser.js";
import { goParserStatus } from "../src/core/architecture/project/go-parser.js";
import { revision } from "./helpers.js";

function source(path: string, raw: string) {
  return { path, content: numberedText(raw), rawText: () => raw };
}

function pythonGraph(files: Record<string, string>, overrides: Partial<Parameters<typeof prepareProjects>[0]> = {}) {
  const sources = Object.entries(files).map(([path, raw]) => source(path, raw));
  const census = buildSourceCensus({ revision, inventory: sources.map((item) => ({ path: item.path, size: 0, entryKind: "file" as const, selected: true })) });
  const snapshot = createSourceSnapshot({ revision, sources, census });
  const project = prepareProjects({ revision, snapshot, census, ...overrides });
  const graph = buildModuleGraph({ revision, snapshot, census, project });
  return { snapshot, census, project, graph };
}

const manifest = "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n";

describe("M8 Python project and source-module graph", () => {
  it("parses Python syntax with the bundled WASM grammar", () => {
    expect(pythonParserStatus().status).toBe("available");
    const parsed = parsePythonSource([
      "import os, pkg.mod as alias",
      "from . import sibling",
      "from ..pkg import thing",
      "from requests import get",
      "import importlib",
      "dynamic = importlib.import_module(\"pkg.dynamic\")",
      "other = __import__('pkg.other')",
      "class Service: pass",
      "def main(): pass",
      "if __name__ == \"__main__\": main()",
    ].join("\n"));
    expect(parsed?.imports.map((item) => item.source)).toEqual(["os", "pkg.mod", ".", "..pkg", "requests", "importlib", "pkg.dynamic", "pkg.other"]);
    expect(parsed?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Service", kind: "class" }),
      expect.objectContaining({ name: "main", kind: "function" }),
    ]));
    expect(parsed?.mainGuardLine).toBe(10);
    expect(parsed?.diagnostics).toHaveLength(0);
  });

  it("keeps Go and Python parser instances isolated", () => {
    expect(goParserStatus().status).toBe("available");
    expect(goParserStatus().status).toBe("available");
    expect(parsePythonSource("import os\n")?.imports[0]?.source).toBe("os");
  });

  it("collects future imports and imports nested in functions and try blocks", () => {
    const parsed = parsePythonSource('from __future__ import annotations\ndef main():\n    from . import nested\n    try:\n        import os\n');
    expect(parsed?.imports.map((item) => item.source)).toEqual(expect.arrayContaining(["__future__", ".", "os"]));
  });

  it("does not count import examples inside Python docstrings", () => {
    const { graph } = pythonGraph({
      "pkg/doc.py": '\"\"\"\nimport time of Click down\nfrom functools import update_wrapper\n\"\"\"\n',
    });
    expect(graph.importDeclarations.expected).toBe(0);
    expect(graph.importDeclarations.missing).toHaveLength(0);
  });

  it("resolves src-layout packages, __init__ barrels and literal dynamic imports", () => {
    const { graph, project } = pythonGraph({
      "pyproject.toml": manifest,
      "src/demo/__init__.py": "from . import api\n",
      "src/demo/__main__.py": "from . import api\nif __name__ == \"__main__\": api.main()\n",
      "src/demo/api.py": "from .store import get\nfrom requests import get as http_get\n",
      "src/demo/store.py": "VALUE = 1\ndef get(): return VALUE\n",
      "src/demo/lazy.py": "import importlib\nvalue = importlib.import_module(\"demo.store\")\n",
    });
    expect(project.parsers.find((parser) => parser.id === "ast-python")?.status).not.toBe("unavailable");
    expect(graph.nodes.some((node) => node.path === "src/demo/__init__.py" && node.kind === "barrel")).toBe(true);
    expect(graph.nodes.some((node) => node.path === "src/demo/__main__.py" && node.entrypoint)).toBe(true);
    const api = graph.nodes.find((node) => node.path === "src/demo/api.py");
    const store = graph.nodes.find((node) => node.path === "src/demo/store.py");
    expect(graph.edges.some((edge) => edge.from === api?.id && edge.to === store?.id && edge.toKind === "module")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "dynamic" && edge.to === store?.id)).toBe(true);
    expect(graph.edges.some((edge) => edge.source === "requests" && edge.toKind === "external")).toBe(true);
    expect(graph.importDeclarations.missing).toHaveLength(0);
    expect(graph.evidenceRecords.some((record) => record.extractor.startsWith("ast:python-import:"))).toBe(true);
    expect(graph.gates.blockedViews).not.toContain("module-architecture");
  });

  it("resolves relative imports and preserves cycles", () => {
    const { graph } = pythonGraph({
      "pkg/__init__.py": "from . import mod\n",
      "pkg/mod.py": "from . import sibling\n",
      "pkg/sibling.py": "from . import mod\nvalue = 1\n",
      "pkg/sub/__init__.py": "",
      "pkg/sub/feature.py": "from ..sibling import value\n",
    });
    const mod = graph.nodes.find((node) => node.path === "pkg/mod.py");
    const sibling = graph.nodes.find((node) => node.path === "pkg/sibling.py");
    const feature = graph.nodes.find((node) => node.path === "pkg/sub/feature.py");
    expect(graph.edges.some((edge) => edge.from === mod?.id && edge.to === sibling?.id)).toBe(true);
    expect(graph.edges.some((edge) => edge.from === sibling?.id && edge.to === mod?.id)).toBe(true);
    expect(graph.edges.some((edge) => edge.from === feature?.id && edge.to === sibling?.id)).toBe(true);
    expect(graph.cycles.length).toBeGreaterThan(0);
  });

  it("preserves aliases and every from-import target, including partial misses", () => {
    const complete = pythonGraph({
      "pkg/__init__.py": "from . import a as a\nfrom . import b, c\n",
      "pkg/a.py": "VALUE = 1\n",
      "pkg/b.py": "VALUE = 2\n",
      "pkg/c.py": "VALUE = 3\n",
    });
    const init = complete.graph.nodes.find((node) => node.path === "pkg/__init__.py");
    for (const path of ["pkg/a.py", "pkg/b.py", "pkg/c.py"]) {
      const target = complete.graph.nodes.find((node) => node.path === path);
      expect(complete.graph.edges.some((edge) => edge.from === init?.id && edge.to === target?.id)).toBe(true);
    }
    expect(complete.graph.edges.some((edge) => edge.from === init?.id && edge.to === init?.id)).toBe(false);
    const partial = pythonGraph({
      "pkg/__init__.py": "from . import b, c\n",
      "pkg/b.py": "VALUE = 2\n",
    });
    expect(partial.graph.edges.some((edge) => edge.to.endsWith("pkg/b.py"))).toBe(true);
    expect(partial.graph.unresolvedImports).toHaveLength(1);
    expect(partial.graph.gates.blockedViews).toContain("module-architecture");
  });

  it("resolves barrel symbols without dropping explicit module targets", () => {
    const valid = pythonGraph({
      "pkg/__init__.py": "VERSION = 1\nfrom .core import Command\nfrom . import VERSION\n",
      "pkg/core.py": "class Command: pass\n",
    });
    expect(valid.graph.unresolvedImports).toHaveLength(0);
    const partial = pythonGraph({
      "pkg/__init__.py": "from .pkg import a, b\n",
      "pkg/pkg/__init__.py": "",
      "pkg/pkg/a.py": "VALUE = 1\n",
    });
    expect(partial.graph.edges.some((edge) => edge.to.endsWith("pkg/pkg/a.py"))).toBe(true);
    expect(partial.graph.unresolvedImports).toHaveLength(1);
    const sameName = pythonGraph({
      "pkg/__init__.py": "from pkg import pkg\n",
      "pkg/pkg.py": "VALUE = 1\n",
    });
    expect(sameName.graph.edges.some((edge) => edge.to.endsWith("pkg/pkg.py"))).toBe(true);
  });

  it("resolves re-exported symbols across module boundaries", () => {
    const { graph } = pythonGraph({
      "pkg/__init__.py": "from .core import Node\n",
      "pkg/core.py": "from .other import Node\n",
      "pkg/other.py": "class Node: pass\n",
      "pkg/app.py": "from .core import Node\n",
    });
    expect(graph.unresolvedImports).toHaveLength(0);
    expect(graph.edges.some((edge) => edge.to.endsWith("pkg/core.py"))).toBe(true);
  });

  it("does not use function-local imports as re-export bindings", () => {
    const { graph } = pythonGraph({
      "pkg/barrel.py": "def factory():\n    from .core import Node\n",
      "pkg/core.py": "class Node: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
    });
    expect(graph.unresolvedImports).toHaveLength(1);
    expect(graph.edges.some((edge) => edge.from.endsWith("pkg/barrel.py") && edge.to.endsWith("pkg/core.py"))).toBe(true);
  });

  it("blocks a missing relative wildcard import", () => {
    const { graph } = pythonGraph({ "pkg/mod.py": "from .missing import *\n" });
    expect(graph.unresolvedImports).toHaveLength(1);
    expect(graph.unresolvedImports[0].reason).toContain("wildcard");
    expect(graph.edges.some((edge) => edge.toKind === "external" && edge.source === ".missing")).toBe(false);
  });

  it("blocks a nested src escape even without a manifest", () => {
    const { graph } = pythonGraph({
      "packages/a/src/demo/mod.py": "from ..sibling import value\n",
      "packages/a/src/sibling.py": "value = 1\n",
    });
    expect(graph.unresolvedImports).toHaveLength(1);
  });

  it("resolves plain aliases, external bindings and wildcard re-exports", () => {
    const plain = pythonGraph({
      "pkg/barrel.py": "import pkg.core as core\n",
      "pkg/core.py": "VALUE = 1\n",
      "pkg/app.py": "from .barrel import core\n",
    });
    expect(plain.graph.unresolvedImports).toHaveLength(0);
    const external = pythonGraph({
      "pkg/barrel.py": "from requests import get as http_get\n",
      "pkg/app.py": "from .barrel import http_get\n",
    });
    expect(external.graph.unresolvedImports).toHaveLength(0);
    const wildcard = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "class Node: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
    });
    expect(wildcard.graph.unresolvedImports).toHaveLength(0);
    const restricted = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "__all__ = ['Other']\nclass Node: pass\nclass Other: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
    });
    expect(restricted.graph.unresolvedImports).toHaveLength(1);
    const tuple = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "__all__ = ('Node',)\nclass Node: pass\nclass Hidden: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
      "pkg/private.py": "from .barrel import Hidden\n",
    });
    expect(tuple.graph.unresolvedImports).toHaveLength(1);
    const direct = pythonGraph({
      "pkg/core.py": "__all__ = ['Other']\nclass Node: pass\nclass Other: pass\n",
      "pkg/app.py": "from .core import Node\n",
    });
    expect(direct.graph.unresolvedImports).toHaveLength(0);
    const dynamic = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "names = ['Node']\n__all__ = names\nclass Node: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
    });
    expect(dynamic.graph.unresolvedImports).toHaveLength(1);
    const interpolated = pythonGraph({
      "pkg/mod.py": 'import importlib\nimportlib.import_module(f"requests.{name}")\n',
    });
    expect(interpolated.graph.unresolvedImports).toHaveLength(1);
    expect(interpolated.graph.unresolvedImports[0].reason).toContain("not a string literal");
    const packaged = pythonGraph({
      "pkg/sub/mod.py": 'import importlib\nimportlib.import_module(".sibling", package="pkg")\nimportlib.import_module(".other")\n',
      "pkg/sibling.py": "VALUE = 1\n",
      "pkg/sub/sibling.py": "VALUE = 2\n",
    });
    expect(packaged.graph.edges.some((edge) => edge.to.endsWith("pkg/sibling.py"))).toBe(true);
    expect(packaged.graph.edges.some((edge) => edge.to.endsWith("pkg/sub/sibling.py"))).toBe(false);
    expect(packaged.graph.unresolvedImports).toHaveLength(1);
    const annotated = pythonGraph({
      "pkg/core.py": "Node: int\n",
      "pkg/app.py": "from .core import Node\n",
    });
    expect(annotated.graph.unresolvedImports).toHaveLength(1);
    const mutated = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "__all__ = ['Node']\n__all__ *= 0\nclass Node: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
    });
    expect(mutated.graph.unresolvedImports).toHaveLength(1);
    const reassigned = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "names = []\n__all__ = names\n__all__ = ['Node']\nclass Node: pass\n",
      "pkg/app.py": "from .barrel import Node\n",
    });
    expect(reassigned.graph.unresolvedImports).toHaveLength(0);
    const underscore = pythonGraph({
      "pkg/barrel.py": "from .core import *\n",
      "pkg/core.py": "__all__ = ['_private']\n_private = 1\n",
      "pkg/app.py": "from .barrel import _private\n",
    });
    expect(underscore.graph.unresolvedImports).toHaveLength(0);
  });

  it("classifies external dynamic imports as external instead of missing local modules", () => {
    const { graph } = pythonGraph({
      "pkg/mod.py": 'import importlib\nimportlib.import_module("requests")\n__import__("json")\n',
    });
    expect(graph.unresolvedImports).toHaveLength(0);
    expect(graph.edges.some((edge) => edge.toKind === "external" && edge.source === "requests")).toBe(true);
    expect(graph.edges.some((edge) => edge.toKind === "external" && edge.source === "json")).toBe(true);
  });

  it("does not create a CLI runtime from a function-local main guard", () => {
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, [
      source("src/demo/configure.py", "def configure():\n    if __name__ == '__main__':\n        pass\n"),
    ]);
    expect(analysis.inventory.signals.some((signal) => signal.evidence.detector === "python-main-guard")).toBe(false);
    expect(analysis.facts.nodes.some((node) => node.id === "python:src/demo")).toBe(false);
    const { project } = pythonGraph({ "src/demo/configure.py": "def configure():\n    if __name__ == '__main__':\n        pass\n" });
    expect(project.declarations.some((declaration) => declaration.kind === "entrypoint" && declaration.sourcePath === "src/demo/configure.py" && declaration.detail.includes("__main__ guard"))).toBe(false);
  });

  it("does not treat nested definitions or aliased re-export names as module bindings", () => {
    const nested = pythonGraph({
      "pkg/core.py": "def factory():\n    class Node: pass\n",
      "pkg/app.py": "from .core import Node\n",
    });
    expect(nested.graph.unresolvedImports).toHaveLength(1);
    const conditional = pythonGraph({
      "pkg/conditional.py": "if True:\n    def getchar(): pass\n",
      "pkg/app.py": "from .conditional import getchar\n",
    });
    expect(conditional.graph.unresolvedImports).toHaveLength(0);
    const aliases = pythonGraph({
      "pkg/barrel.py": "from .core import Node as PublicNode\n",
      "pkg/core.py": "class Node: pass\n",
      "pkg/app.py": "from .barrel import PublicNode\n",
      "pkg/invalid.py": "from .barrel import Node\n",
    });
    expect(aliases.graph.unresolvedImports).toHaveLength(1);
    expect(aliases.graph.unresolvedImports[0].path).toBe("pkg/invalid.py");
    const submodule = pythonGraph({
      "pkg/a/api.py": "VALUE = 1\n",
      "pkg/b.py": "from .a import api\n",
      "pkg/c.py": "from .b import api\n",
    });
    expect(submodule.graph.unresolvedImports).toHaveLength(0);
  });

  it("blocks a missing submodule of a known local absolute package", () => {
    const { graph } = pythonGraph({
      "src/demo/__init__.py": "",
      "src/demo/app.py": "import demo.missing\n",
    });
    expect(graph.unresolvedImports).toHaveLength(1);
    expect(graph.edges.some((edge) => edge.toKind === "external" && edge.source === "demo.missing")).toBe(false);
    expect(graph.gates.blockedViews).toContain("module-architecture");
  });

  it("reports a literal dynamic import that is absent from the snapshot as dynamic", () => {
    const { graph } = pythonGraph({
      "pkg/mod.py": 'import importlib\nimportlib.import_module("pkg.missing")\n',
    });
    expect(graph.unresolvedImports).toHaveLength(1);
    expect(graph.unresolvedImports[0].reason).toContain("dynamic Python import target");
  });

  it("isolates same-named modules by workspace and fails ambiguous absolute imports", () => {
    const files = {
      "packages/a/pyproject.toml": manifest,
      "packages/b/pyproject.toml": manifest,
      "packages/c/pyproject.toml": manifest,
      "packages/a/src/common/__init__.py": "VALUE = 'a'\n",
      "packages/b/src/common/__init__.py": "VALUE = 'b'\n",
      "packages/b/src/common/main.py": "import common\n",
      "packages/c/src/app/main.py": "import common\n",
    };
    const { graph } = pythonGraph(files);
    const main = graph.nodes.find((node) => node.path === "packages/b/src/common/main.py");
    const expected = graph.nodes.find((node) => node.path === "packages/b/src/common/__init__.py");
    const other = graph.nodes.find((node) => node.path === "packages/a/src/common/__init__.py");
    expect(graph.edges.some((edge) => edge.from === main?.id && edge.to === expected?.id && !edge.crossPackage)).toBe(true);
    expect(graph.edges.some((edge) => edge.from === main?.id && edge.to === other?.id)).toBe(false);
    expect(graph.unresolvedImports.some((item) => item.path === "packages/c/src/app/main.py" && item.reason.includes("ambiguous"))).toBe(true);
  });

  it("does not create a CLI runtime from a docstring main guard", () => {
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, [
      source("src/demo/pytree.py", '\"\"\"\nExample:\nif __name__ == "__main__":\n    main()\n\"\"\"\n'),
    ]);
    expect(analysis.inventory.signals.some((signal) => signal.evidence.detector === "python-main-guard")).toBe(false);
    expect(analysis.facts.nodes.some((node) => node.id === "python:src/demo")).toBe(false);
  });

  it("blocks relative imports that escape the top-level package", () => {
    const { graph } = pythonGraph({
      "pkg/mod.py": "from ..sibling import value\n",
      "sibling.py": "value = 1\n",
    });
    expect(graph.unresolvedImports).toHaveLength(1);
    expect(graph.edges.some((edge) => edge.to.endsWith("sibling.py"))).toBe(false);
    expect(graph.gates.blockedViews).toContain("module-architecture");
  });

  it("blocks relative imports escaping a nested src package", () => {
    const { graph } = pythonGraph({
      "packages/a/pyproject.toml": manifest,
      "packages/a/src/demo/mod.py": "from ..sibling import value\n",
      "packages/a/src/sibling.py": "value = 1\n",
    });
    expect(graph.unresolvedImports).toHaveLength(1);
    expect(graph.gates.blockedViews).toContain("module-architecture");
  });

  it("blocks unresolved relative and non-literal dynamic imports", () => {
    const { graph } = pythonGraph({
      "pkg/mod.py": "from . import missing\nimport importlib\nimportlib.import_module(name)\n",
    });
    expect(graph.unresolvedImports).toHaveLength(2);
    expect(graph.gates.blockedViews).toContain("module-architecture");
    expect(graph.gates.runtimeOverviewUnaffected).toBe(true);
  });

  it("retains the independent import denominator when the Python adapter is disabled", () => {
    const files = {
      "pkg/mod.py": "from . import sibling\n",
      "pkg/sibling.py": "VALUE = 1\n",
    };
    const available = pythonGraph(files);
    const unavailable = pythonGraph(files, { adapters: [createUnavailableAdapter("ast-python", ["python"], "Python mutation")] });
    expect(available.graph.importDeclarations.expected).toBe(1);
    expect(unavailable.graph.importDeclarations.expected).toBe(1);
    expect(unavailable.graph.importDeclarations.missing).toHaveLength(1);
    expect(unavailable.graph.gates.blockedViews).toContain("module-architecture");
    expect(unavailable.project.units.some((unit) => unit.status === "parser-unavailable")).toBe(true);
  });

  it("turns syntax diagnostics into a blocking module gate", () => {
    const { graph } = pythonGraph({ "pkg/broken.py": "def broken(:\n" });
    expect(graph.gates.blockedViews).toContain("module-architecture");
  });

  it("delivers a Python CLI runtime and module view without claiming protocol support", async () => {
    const sources = Object.entries({
      "pyproject.toml": manifest,
      "src/demo/__main__.py": "from . import api\nif __name__ == \"__main__\": api.main()\n",
      "src/demo/api.py": "def main(): return 0\n",
    }).map(([path, raw]) => source(path, raw));
    const outDir = await mkdtemp(join(tmpdir(), "repomap-python-runtime-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources,
      sourceReceipt: { scope: "repository", directories: 3, files: sources.length, bytes: 100 },
      outDir,
      requestedViews: ["module"],
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.project.parsers.find((parser: { id: string }) => parser.id === "ast-python")?.status).not.toBe("unavailable");
    expect(receipt.viewManifest.views.some((view: { kind: string }) => view.kind === "modules")).toBe(true);
  });

  it("does not treat a __name__ expression as a Python main guard", () => {
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, [
      source("src/demo/pytree.py", 'class Node:\n    def __repr__(self):\n        return f"{self.__class__.__name__}"\n'),
    ]);
    expect(analysis.inventory.signals.some((signal) => signal.evidence.path === "src/demo/pytree.py" && signal.evidence.detector === "python-main-guard")).toBe(false);
  });

  it("fails a full Python request while protocol extraction is unimplemented", async () => {
    const sources = [source("src/demo/__main__.py", "if __name__ == \"__main__\": print('ok')\n")];
    const outDir = await mkdtemp(join(tmpdir(), "repomap-python-full-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources,
      sourceReceipt: { scope: "repository", directories: 3, files: sources.length, bytes: 100 },
      outDir,
      requestedViews: ["full"],
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.delivery.views.find((view: { view: string }) => view.view === "protocol-flows")?.status).toBe("failed");
  });
});
