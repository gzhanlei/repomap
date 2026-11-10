import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { architectureFactSetSchema } from "../src/core/architecture/facts.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { buildDeclaredScope, buildDeliveryStatement, defaultArchitectureView, deliveryExitCode, resolveRequestedViews } from "../src/core/architecture/scope.js";
import { parseCliArguments } from "../src/cli.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

async function fixtureInput() {
  const root = await nextFixture();
  const loaded = await loadLocalRepositorySources(root);
  const outDir = await mkdtemp(join(tmpdir(), "repomap-scope-"));
  return {
    identity: { kind: "local" as const, owner: "local", repo: "demo", revision },
    sources: loaded.sources,
    inventory: loaded.inventory,
    sourceReceipt: loaded.receipt,
    outDir,
  };
}

describe("M0 delivery contract", () => {
  it("declares runtime-overview and never claims a full architecture when publishable", async () => {
    const input = await fixtureInput();
    const receipt = await analyzeSources({ ...input, render: false, deliver: vi.fn() });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.view).toBe("runtime-overview");
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.declaredScope.requestedViews).toEqual(["runtime-overview"]);
    expect(receipt.declaredScope.revision).toBe(revision);
    expect(receipt.declaredScope.capabilityGaps.length).toBeGreaterThan(0);
    expect(receipt.delivery.fullArchitecture).toBe(false);
    const analysis = JSON.parse(await readFile(join(input.outDir, "architecture.analysis.json"), "utf8"));
    expect(analysis.view).toBe("runtime-overview");
    expect(analysis.fullArchitecture).toBe(false);
    expect(analysis.delivery.fullArchitecture).toBe(false);
    expect(analysis.version).toBe(2);
  });

  it("does not upgrade the view when a visual check passes", async () => {
    const input = await fixtureInput();
    const deliver = vi.fn(async () => ({ ok: true, command: "deliver" }));
    const check = vi.fn(async () => ({ ok: true, command: "visual-check" }));
    const receipt = await analyzeSources({ ...input, visualCheck: true, deliver, check });
    expect(receipt.status).toBe("accepted");
    expect(receipt).toMatchObject({ visualReview: "pending" });
    expect(receipt.view).toBe(defaultArchitectureView);
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.delivery.view).toBe("runtime-overview");
  });

  it("renders only the requested runtime overview by default", async () => {
    const input = await fixtureInput();
    const deliver = vi.fn(async () => ({ ok: true, command: "deliver" }));
    const receipt = await analyzeSources({ ...input, deliver });
    if (receipt.status !== "accepted") throw new Error("expected accepted runtime delivery");
    const overviewPages = receipt.viewManifest.views.find((view: { kind: string }) => view.kind === "overview")?.pages.length ?? 0;
    expect(overviewPages).toBeGreaterThan(0);
    expect(deliver).toHaveBeenCalledTimes(overviewPages);
    expect(receipt.viewArtifacts.every((artifact: { kind: string }) => artifact.kind === "overview")).toBe(true);
    for (const view of receipt.viewManifest.views) {
      for (const page of view.pages) expect(existsSync(join(input.outDir, page.json))).toBe(true);
    }
  });

  it("keeps failed coverage at the same view and never sets fullArchitecture", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-scope-failed-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: [{ path: "lib/util.ts", content: "1: export const value = 1;" }],
      sourceReceipt: { scope: "repository", directories: 1, files: 1, bytes: 25 },
      outDir, render: false, deliver: vi.fn(),
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.view).toBe("runtime-overview");
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.delivery.publishable).toBe(false);
  });

  it("fails a full request with a non-zero exit code without faking total success", () => {
    const statement = buildDeliveryStatement({ status: "accepted", publishable: true, requestedViews: ["full"], visualPassed: true });
    expect(statement.fullArchitecture).toBe(false);
    expect(statement.views.find((entry) => entry.view === "full-declared-scope")?.status).toBe("failed");
    expect(statement.views.find((entry) => entry.view === "runtime-overview")?.status).toBe("accepted");
    expect(deliveryExitCode(statement)).toBe(1);
    expect(deliveryExitCode(buildDeliveryStatement({ status: "facts-ready", publishable: true }))).toBe(0);
    expect(resolveRequestedViews(["full"])).toEqual([
      "system-context", "runtime-overview", "module-architecture", "protocol-flows", "full-declared-scope",
    ]);
  });

  it("does not invoke Archify or Chromium under --no-render", async () => {
    const input = await fixtureInput();
    const deliver = vi.fn();
    const check = vi.fn();
    const receipt = await analyzeSources({ ...input, render: false, visualCheck: true, deliver, check });
    expect(receipt.status).toBe("facts-ready");
    expect(deliver).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(receipt.visualReview).toBe("not-requested");
    expect(receipt.delivery.reason).not.toContain("passing visual check");
    expect(existsSync(join(input.outDir, "architecture.html"))).toBe(false);
    expect(existsSync(join(input.outDir, "architecture.json"))).toBe(false);
  });

  it("records the declared scope, capability gaps, user exclusions and explicit build context", () => {
    const scope = buildDeclaredScope({ revision, languages: ["typescript", "go"], userExclusions: ["docs/**"], strictExternalHosts: true, requestedViews: ["runtime"] });
    expect(scope.languages).toEqual(["go", "typescript"]);
    expect(scope.userExclusions).toEqual(["docs/**"]);
    expect(scope.capabilityGaps).toContain("ast-typescript");
    expect(scope.strictExternalHosts).toBe(true);
    expect(scope.buildContext).toEqual({ goos: "linux", goarch: "amd64", buildTags: [] });
    expect(scope.parsers.find((parser) => parser.id === "ast-typescript")?.status).toBe("partial");
    expect(scope.parsers.find((parser) => parser.id === "ast-go")?.status).toBe("partial");
    expect(scope.parsers.find((parser) => parser.id === "regex-line-scan")?.status).toBe("partial");
  });

  it("still parses legacy facts v1 without any IR-only fields", () => {
    const legacy = {
      version: 1, revision, roots: ["actor:users"],
      nodes: [{ id: "actor:users", kind: "user", label: "用户", synthetic: true, signalIds: [], evidence: [] }],
      edges: [], omissions: [],
    };
    const parsed = architectureFactSetSchema.parse(legacy);
    expect(JSON.stringify(parsed)).not.toContain("evidenceIds");
  });

  it("applies user scope to facts and independent declarations, not only receipt metadata", () => {
    const sources = [
      { path: "package.json", content: '1: {"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
      { path: "app/api/products/route.ts", content: "1: export async function GET() {}" },
    ];
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, sources, { include: ["app/page.tsx", "package.json"] });
    expect(analysis.facts.nodes.some((node) => node.id === "next:root:ui")).toBe(true);
    expect(analysis.facts.nodes.some((node) => node.id === "next:root:api")).toBe(false);
    expect(analysis.census.files.find((file) => file.path === "app/api/products/route.ts")?.reason).toBe("out-of-scope");
    expect(analysis.census.totals.selected).toBe(2);
    expect(analysis.declarations.declarations.some((declaration) => declaration.sourcePath === "app/api/products/route.ts")).toBe(false);
  });

  it("blocks delivery when an independent runtime declaration has no fact owner", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-declaration-gate-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: [{ path: "app/api/products/route.ts", content: "1: const value = 1;" }],
      sourceReceipt: { scope: "repository", directories: 1, files: 1, bytes: 25 },
      outDir, render: false, deliver: vi.fn(),
    });
    expect(receipt.declarationCoverage.blockingViews).toContain("runtime-overview");
    expect(receipt).toMatchObject({ status: "failed", error: expect.stringContaining("Independent declaration coverage") });
    expect(receipt.delivery.views.find((entry) => entry.view === "runtime-overview")?.omissionCount).toBeGreaterThan(0);
  });

  it("parses the new CLI view and scope flags", () => {
    const parsed = parseCliArguments(["analyze", "owner/repo", "--view", "runtime", "--view", "full", "--include", "src/**", "--exclude", "docs/**", "--require-external-hosts", "--no-render"]);
    if ("help" in parsed || "version" in parsed) throw new Error("expected analysis options");
    expect(parsed.requestedViews).toEqual(["runtime", "full"]);
    expect(parsed.include).toEqual(["src/**"]);
    expect(parsed.exclude).toEqual(["docs/**"]);
    expect(parsed.userExclusions).toEqual(["docs/**"]);
    expect(parsed.strictExternalHosts).toBe(true);
    expect(parsed.render).toBe(false);
  });
});
