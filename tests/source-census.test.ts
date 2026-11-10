import { mkdir, mkdtemp, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { assertSourceCensusReconciled, buildSourceCensus, sourceCensusSchema, type RepositoryFileEntry } from "../src/core/architecture/census.js";
import { classifySourcePath, isDeclarationOnlyPath } from "../src/core/architecture/file-roles.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { revision } from "./helpers.js";

async function censusFixture() {
  const root = await mkdtemp(join(tmpdir(), "repomap-census-"));
  await mkdir(join(root, "cmd"), { recursive: true });
  await mkdir(join(root, "web/src"), { recursive: true });
  await mkdir(join(root, "web/tests"), { recursive: true });
  await mkdir(join(root, "prose"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "node_modules/dep"), { recursive: true });
  await writeFile(join(root, "go.mod"), "module example.com/app\n");
  await writeFile(join(root, "cmd/main.go"), "package main\nfunc main() {}\n");
  await writeFile(join(root, "web/package.json"), '{"name":"web","dependencies":{"next":"16.0.0"}}\n');
  await writeFile(join(root, "web/src/index.ts"), "export const value = 1;\n");
  await writeFile(join(root, "web/tests/index.test.ts"), "it('works', () => {});\n");
  await writeFile(join(root, "prose/package-lock.json"), '{"dependencies":{"postgres":{"version":"3.4.5"}}}\n');
  await writeFile(join(root, "docs/design.md"), "# design\n");
  await writeFile(join(root, "public-logo.png"), "binary");
  await writeFile(join(root, "extensionless-exec"), "#!/bin/sh\necho hi\n");
  await writeFile(join(root, "node_modules/dep/index.js"), "module.exports = 1;\n");
  await symlink("go.mod", join(root, "link-to-mod"));
  return root;
}

describe("M1 raw source census", () => {
  it("reconciles every raw entry with exactly one disposition", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const census = buildSourceCensus({ revision, inventory: loaded.inventory });
    expect(census.totals.rawEntries).toBe(loaded.inventory.length);
    expect(census.files).toHaveLength(census.totals.rawEntries);
    expect(new Set(census.files.map((file) => file.path)).size).toBe(census.totals.rawEntries);
    expect(census.reconciled).toBe(true);
    expect(sourceCensusSchema.parse(census).reconciled).toBe(true);
    expect(() => assertSourceCensusReconciled(census)).not.toThrow();
    expect(census.totals.selected).toBe(census.files.filter((file) => file.status === "selected").length);
    expect(census.totals.selected).toBeLessThan(loaded.sources.length); // lockfile remains raw-only
    expect(loaded.inventory.some((entry) => entry.path === "node_modules/dep/index.js")).toBe(true);
    const vendored = census.files.find((file) => file.path === "node_modules/dep/index.js");
    expect(vendored).toMatchObject({ role: "vendored", status: "excluded", reason: "vendored" });
  });

  it("uses honest raw states instead of pretending files were AST parsed", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const census = buildSourceCensus({ revision, inventory: loaded.inventory });
    const byPath = new Map(census.files.map((file) => [file.path, file]));
    expect(byPath.get("prose/package-lock.json")?.role).toBe("lockfile");
    expect(byPath.get("prose/package-lock.json")?.status).toBe("excluded");
    expect(byPath.get("web/tests/index.test.ts")?.status).toBe("excluded");
    expect(byPath.get("docs/design.md")?.role).toBe("documentation");
    expect(byPath.get("web/package.json")?.role).toBe("manifest");
    expect(byPath.get("web/src/index.ts")?.status).toBe("selected");
    expect(byPath.get("web/src/index.ts")?.parser).toBe("regex-line-scan@1");
    expect(byPath.get("link-to-mod")?.status).toBe("inventoried");
    expect(byPath.get("link-to-mod")?.entryKind).toBe("symlink");
    expect(byPath.get("extensionless-exec")?.status).toBe("unsupported");
    expect(byPath.get("extensionless-exec")?.reason).toBe("unsupported-language");
    expect(census.files.every((file) => file.status !== "parse-error")).toBe(true);
    expect(census.capabilityGaps).toContain("ast-go");
  });

  it("records exclusion rules with counts, not only a total", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const census = buildSourceCensus({ revision, inventory: loaded.inventory });
    expect(census.exclusions.length).toBeGreaterThan(0);
    expect(census.exclusions.every((rule) => rule.count >= 0 && rule.reason.length > 0)).toBe(true);
    expect(census.byReason.lockfile).toBe(1);
    expect(census.byRole.lockfile).toBe(1);
    expect(census.exclusions.some((rule) => rule.rule.includes("node_modules"))).toBe(true);
  });

  it("assigns package ownership from the nearest manifest", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const census = buildSourceCensus({ revision, inventory: loaded.inventory });
    const byPath = new Map(census.files.map((file) => [file.path, file]));
    expect(byPath.get("web/src/index.ts")?.packageId).toBe("package:web");
    expect(byPath.get("cmd/main.go")?.packageId).toBe("package:root");
    expect(census.packages.map((entry) => entry.id).sort()).toEqual(["package:root", "package:web"]);
  });

  it("separates declaration-only files from runtime evidence", () => {
    expect(classifySourcePath("prose/package-lock.json")).toBe("lockfile");
    expect(isDeclarationOnlyPath("prose/package-lock.json")).toBe(true);
    expect(isDeclarationOnlyPath("web/package.json")).toBe(true);
    expect(isDeclarationOnlyPath("web/src/index.ts")).toBe(false);
  });

  it("records user exclusions as scope, never as a detector capability", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const census = buildSourceCensus({ revision, inventory: loaded.inventory, userExclusions: ["docs/**"] });
    expect(census.files.find((file) => file.path === "docs/design.md")?.reason).toBe("out-of-scope");
    expect(census.capabilityGaps).toContain("ast-typescript");
    expect(census.capabilityGaps).not.toContain("docs/**");
  });

  it("keeps local and archive-style raw entries at parity", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const archiveEntries: RepositoryFileEntry[] = loaded.inventory.map((entry) => ({ ...entry }));
    const local = buildSourceCensus({ revision, inventory: loaded.inventory });
    const remote = buildSourceCensus({ revision, inventory: archiveEntries });
    expect(remote.byStatus).toEqual(local.byStatus);
    expect(remote.byRole).toEqual(local.byRole);
    expect(remote.totals.rawEntries).toBe(local.totals.rawEntries);
  });

  it("records gitlinks as blocking unresolved submodules", () => {
    const census = buildSourceCensus({
      revision,
      inventory: [
        { path: ".gitmodules", size: 20, entryKind: "file", selected: false },
        { path: "vendor/lib", size: 0, entryKind: "gitlink", selected: false },
      ],
    });
    expect(census.files.find((file) => file.path === "vendor/lib")?.status).toBe("inventoried");
    expect(census.omissions.some((omission) => omission.reason === "submodule-gitlink" && omission.blocking)).toBe(true);
  });

  it("blocks every view and HTML when the raw entry budget is exceeded", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const outDir = await mkdtemp(join(tmpdir(), "repomap-raw-budget-"));
    const deliver = vi.fn();
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: loaded.sources, inventory: loaded.inventory, sourceReceipt: loaded.receipt,
      outDir, rawBudgets: { maxRawEntries: 2 }, deliver,
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.rawBudgetExceeded).toBe(true);
    expect(receipt).toMatchObject({ status: "failed", error: expect.stringContaining("budget") });
    expect(receipt.delivery.views.every((entry) => entry.status !== "accepted")).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    const census = JSON.parse(await readFile(join(outDir, "architecture.source-census.json"), "utf8"));
    expect(census.rawBudgetExceeded).toBe(true);
  });

  it("fails reconciliation when a raw entry has no disposition", async () => {
    const root = await censusFixture();
    const loaded = await loadLocalRepositorySources(root);
    const census = buildSourceCensus({ revision, inventory: loaded.inventory });
    expect(() => assertSourceCensusReconciled({ ...census, files: census.files.slice(1) })).toThrow("reconcile");
  });

  it("rejects duplicate raw paths instead of silently reconciling a deduplicated subset", () => {
    const inventory = [
      { path: "src/index.ts", size: 1, entryKind: "file" as const, selected: true },
      { path: "src/index.ts", size: 1, entryKind: "file" as const, selected: true },
    ];
    const census = buildSourceCensus({ revision, inventory });
    expect(census.reconciled).toBe(false);
    expect(() => assertSourceCensusReconciled(census)).toThrow("reconcile");
  });

  it("applies include globs to whole path segments, not unrelated prefixes", () => {
    const census = buildSourceCensus({
      revision,
      include: ["src/**"],
      inventory: [
        { path: "src/index.ts", size: 1, entryKind: "file", selected: true },
        { path: "src2/index.ts", size: 1, entryKind: "file", selected: true },
      ],
    });
    expect(census.files.find((file) => file.path === "src/index.ts")?.status).toBe("selected");
    expect(census.files.find((file) => file.path === "src2/index.ts")?.reason).toBe("out-of-scope");
  });

  it("links evidence and declaration IDs back to raw entries", () => {
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: "package main\nfunc main() {}" },
    ]);
    const knownEvidence = new Set(analysis.evidence.records.map((record) => record.id));
    const knownDeclarations = new Set(analysis.declarations.declarations.map((item) => item.declarationId));
    expect(analysis.census.files.some((file) => file.evidenceIds.length > 0)).toBe(true);
    expect(analysis.census.files.some((file) => file.declarationIds.length > 0)).toBe(true);
    expect(analysis.census.files.every((file) => file.evidenceIds.every((id) => knownEvidence.has(id)))).toBe(true);
    expect(analysis.census.files.every((file) => file.declarationIds.every((id) => knownDeclarations.has(id)))).toBe(true);
  });
});
