import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { architectureFactSetSchema, type ArchitectureFactSet } from "../src/core/architecture/facts.js";
import { assertEvidenceReferences, buildEvidenceIndex, evidenceIndexSchema } from "../src/core/architecture/evidence-index.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { architectureIrSchema, irEvidenceIds, operationSchema, projectionManifestSchema } from "../src/core/architecture/ir.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

function factsWithEvidence(evidence: { path: string; line: number; detector: string }[]): ArchitectureFactSet {
  return architectureFactSetSchema.parse({
    version: 1, revision, roots: ["actor:users"],
    nodes: [
      { id: "actor:users", kind: "user", label: "用户", synthetic: true, signalIds: [], evidence: [] },
      { id: "store:mysql", kind: "database", label: "MySQL", signalIds: [], evidence },
    ],
    edges: [{ id: "sql:actor:users->store:mysql", from: "actor:users", to: "store:mysql", kind: "sql", label: "SQL", signalIds: [], evidence }],
    omissions: [],
  });
}

describe("M1 evidence index and IR v2 dual-write", () => {
  it("deduplicates evidence deterministically and classifies roles", () => {
    const evidence = [
      { path: "app.go", line: 12, detector: "mysql-caller" },
      { path: "app.go", line: 12, detector: "mysql-caller" },
      { path: "app.go", line: 13, detector: "mysql-caller" },
      { path: "internal/migrations/mysql/V1.up.sql", line: 2, detector: "store:mysql-schema" },
      { path: "prisma/schema.prisma", line: 2, detector: "mysql-usage" },
    ];
    const index = buildEvidenceIndex(revision, factsWithEvidence(evidence));
    expect(index.records).toHaveLength(4);
    expect(index.records[0].id).toMatch(/^ev:[0-9a-f]{16}$/);
    expect(index.statistics.duplicatesRemoved).toBeGreaterThan(0);
    expect(evidenceIndexSchema.parse(index).records).toHaveLength(4);
    expect(buildEvidenceIndex(revision, factsWithEvidence(evidence)).records.map((record) => record.id)).toEqual(index.records.map((record) => record.id));
    const roles = new Map(index.records.map((record) => [record.path, record.role]));
    expect(roles.get("internal/migrations/mysql/V1.up.sql")).toBe("migration");
    expect(roles.get("prisma/schema.prisma")).toBe("configuration");
    expect(roles.get("app.go")).toBe("runtime-call");
    expect(index.records.every((record) => record.source === "regex")).toBe(true);
  });

  it("keeps facts v1 strict: IR-only evidenceIds never leak into the v1 schema", () => {
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: "package main\nfunc main() {}" },
    ]);
    expect(JSON.stringify(analysis.facts)).not.toContain("evidenceIds");
    expect(analysis.ir.nodes.every((node) => Array.isArray(node.evidenceIds))).toBe(true);
    expect(analysis.ir.edges.every((edge) => Array.isArray(edge.evidenceIds))).toBe(true);
    expect(architectureIrSchema.parse(analysis.ir).version).toBe(2);
  });

  it("has no dangling evidence references across the IR", () => {
    const analysis = analyzeArchitectureFacts({ revision, scope: "repository" }, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: "package main\nfunc main() {}" },
    ]);
    expect(() => assertEvidenceReferences(analysis.evidence, irEvidenceIds(analysis.ir))).not.toThrow();
    expect(() => assertEvidenceReferences(analysis.evidence, ["ev:missing"])).toThrow(/dangling/i);
  });

  it("records representative rendering evidence and remaining IDs, never hiding truncation", () => {
    const facts = factsWithEvidence(Array.from({ length: 9 }, (_, index) => ({ path: "schema.sql", line: index + 1, detector: "store:mysql-schema" })));
    const index = buildEvidenceIndex(revision, facts);
    const reference = index.references.find((entry) => entry.ownerId === "store:mysql");
    expect(reference?.renderedEvidenceIds).toHaveLength(3);
    expect(reference?.remainingEvidenceIds).toHaveLength(6);
    expect(reference?.evidenceIds).toHaveLength(9);
    expect(reference?.selectionReason).toContain("full set retained");
    expect(index.statistics.hiddenEvidenceCount).toBeGreaterThan(0);
  });

  it("defines the versioned discriminated operation union up front", () => {
    const base = { id: "op:1", owner: "package:root", declarationIds: [], evidenceIds: [], targetKind: "unknown" as const, resolution: "unknown" as const };
    const operations = [
      { kind: "http", ...base, method: "GET", path: "/api", callSite: "app.ts:1" },
      { kind: "graphql", ...base, operationName: "GetCart", operationType: "query", documentHash: "abc", callSite: "cart.ts:2" },
      { kind: "queue", ...base, action: "enqueue", topic: "jobs" },
      { kind: "sql", ...base, action: "write", driver: "pgx", callSite: "db.ts:3" },
      { kind: "schedule", ...base, schedule: "* * * * *", jobOwner: "worker" },
      { kind: "config-binding", ...base, configKey: "API_HOST", defaultValue: "", override: "env", usedAt: "config.ts:4" },
    ];
    expect(operations.every((operation) => operationSchema.safeParse(operation).success)).toBe(true);
  });

  it("writes the lossless IR / evidence / projection set alongside facts v1", async () => {
    const root = await nextFixture();
    const loaded = await loadLocalRepositorySources(root);
    const outDir = join(root, "out");
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: loaded.sources, inventory: loaded.inventory, sourceReceipt: loaded.receipt,
      outDir, render: false, deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    const ir = JSON.parse(await readFile(join(outDir, "architecture.ir.json"), "utf8"));
    const evidence = JSON.parse(await readFile(join(outDir, "architecture.evidence.json"), "utf8"));
    const projection = JSON.parse(await readFile(join(outDir, "architecture.projection.json"), "utf8"));
    const declarations = JSON.parse(await readFile(join(outDir, "architecture.declarations.json"), "utf8"));
    const facts = JSON.parse(await readFile(join(outDir, "architecture.facts.json"), "utf8"));
    expect(ir.version).toBe(2);
    expect(ir.revision).toBe(revision);
    expect(ir.evidenceIndex.total).toBe(evidence.records.length);
    expect(evidence.records.length).toBeGreaterThan(0);
    expect(projectionManifestSchema.parse(projection).totals.hidden).toBe(evidence.statistics.hiddenEvidenceCount);
    expect(projection.totals.evidenceTotal).toBeGreaterThan(0);
    expect(declarations.declarations.length).toBeGreaterThan(0);
    expect(JSON.stringify(facts)).not.toContain("evidenceIds");
    expect(receipt.outputs.ir).toContain("architecture.ir.json");
    expect(receipt.outputs.census).toContain("architecture.source-census.json");
    expect(existsSync(join(outDir, "architecture.html"))).toBe(false);
  });
});
