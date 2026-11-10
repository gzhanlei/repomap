import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("M4 SQL operations", () => {
  it("separates reads, writes, transactions and migration ownership", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport "example.com/app"\nfunc main() { app.Serve() }' },
      { path: "app.go", content: 'package app\nimport "database/sql"\nfunc init() {\n db, _ = sql.Open("postgres", "dsn")\n db.Query("SELECT id FROM users")\n db.Exec("INSERT INTO users VALUES (1)")\n db.Begin()\n db.Commit()\n}' },
      { path: "internal/storage/migrations/postgres/V0001.up.sql", content: 'CREATE TABLE users (id TEXT PRIMARY KEY);' },
    ]);
    const operations = analysis.ir.operations.filter((operation) => operation.kind === "sql");
    expect(operations.map((operation) => operation.action)).toEqual(expect.arrayContaining(["read", "write", "transaction", "migration"]));
    expect(operations.every((operation) => operation.targetKind === "database" && operation.driver === "postgres")).toBe(true);
    expect(operations.every((operation) => operation.owner === "go:cmd/app")).toBe(true);
    expect(operations.every((operation) => operation.evidenceIds.length > 0)).toBe(true);
    const evidenceIds = new Set(analysis.evidence.records.map((record) => record.id));
    expect(operations.every((operation) => operation.evidenceIds.every((id) => evidenceIds.has(id)))).toBe(true);
  });
});
