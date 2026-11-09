import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { collectArchitectureSignals } from "../src/core/architecture/signals.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const lockfile = '{\n  "name": "prose",\n  "dependencies": {\n    "postgres": { "version": "3.4.5" },\n    "mysql2": { "version": "3.0.0" }\n  }\n}';

describe("M1 lockfile and evidence bloat negatives", () => {
  it("does not create a PostgreSQL runtime store from a lockfile dependency name", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/writefreely" },
      { path: "cmd/writefreely/main.go", content: "package main\nfunc main() {}" },
      { path: "prose/package-lock.json", content: lockfile },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "store:postgres")).toBe(false);
    expect(analysis.facts.nodes.some((node) => node.id === "store:mysql")).toBe(false);
    expect(analysis.inventory.signals.some((signal) => signal.kind === "store" && signal.evidence.path.includes("package-lock"))).toBe(false);
    const record = analysis.census.files.find((file) => file.path === "prose/package-lock.json");
    expect(record?.role).toBe("lockfile");
    expect(record?.status).toBe("excluded");
    expect(record?.evidenceIds).toEqual([]);
  });

  it("does not let manifest dependency names stand in for runtime drivers", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"dependencies":{"postgres":"3.4.5","mysql2":"3.0.0"},"scripts":{"start":"next start"}}' },
      { path: "app/page.tsx", content: "export default function Page() {}" },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "store:postgres")).toBe(false);
    expect(analysis.facts.nodes.some((node) => node.id === "store:mysql")).toBe(false);
    expect(collectArchitectureSignals(scope, [{ path: "package.json", content: '{"dependencies":{"postgres":"3.4.5"}}' }]).signals.filter((signal) => signal.kind === "store")).toEqual([]);
  });

  it("still recognizes a real driver call after declaration-only files are excluded", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport "example.com/app"\nfunc main() { app.Serve() }' },
      { path: "app.go", content: 'package app\nimport "database/sql"\nfunc init() { db, _ = sql.Open("mysql", "dsn") }' },
      { path: "prose/package-lock.json", content: lockfile },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "store:mysql")).toBe(true);
  });

  it("keeps path-level storage evidence semantic instead of one record per file line", () => {
    const noise = Array.from({ length: 400 }, (_, index) => `const row_${index} = ${index};`).join("\n");
    const sql = `${noise}\nCREATE TABLE accounts (id TEXT PRIMARY KEY);\nALTER TABLE accounts ADD COLUMN name TEXT;\n`;
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport "example.com/app"\nfunc main() { app.Serve() }' },
      { path: "app.go", content: 'package app\nimport "database/sql"\nfunc init() { db, _ = sql.Open("postgres", "dsn") }' },
      { path: "internal/storage/migrations/postgres/V0001.up.sql", content: sql },
    ]);
    const store = analysis.facts.nodes.find((node) => node.id === "store:postgres");
    expect(store).toBeDefined();
    expect(store?.evidence.length).toBeLessThanOrEqual(12);
    const schemaEvidence = store?.evidence.filter((item) => item.path.endsWith(".sql")) ?? [];
    expect(schemaEvidence.length).toBeLessThanOrEqual(3);
    expect(schemaEvidence.length).toBeGreaterThan(0);
    const edge = analysis.facts.edges.find((item) => item.to === "store:postgres");
    expect(edge?.evidence.length).toBeLessThanOrEqual(12);
    expect(analysis.evidence.records.length).toBeLessThan(40);
  });

  it("keeps the existing Prisma datasource declaration as valid store evidence", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0","mysql2":"3.0.0"}}' },
      { path: "app/page.tsx", content: "export default function Page() {}" },
      { path: "prisma/schema.prisma", content: 'datasource db {\n  provider = "mysql"\n}' },
    ]);
    const store = analysis.facts.nodes.find((node) => node.id === "store:mysql");
    expect(store).toBeDefined();
    expect(store?.evidence.some((item) => item.path === "prisma/schema.prisma")).toBe(true);
    expect(analysis.coverage.unclassifiedCriticalSignals).toEqual([]);
  });
});
