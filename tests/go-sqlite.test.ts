import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { collectArchitectureSignals } from "../src/core/architecture/signals.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("Go module-root imports and storage identity", () => {
  it("keeps long runtime labels readable while preserving runtime identity", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/authelia" },
      { path: "internal/suites/example/compose/authelia/resources/main.go", content: "package main\nfunc main() {}" },
    ]);
    const runtime = analysis.facts.nodes.find((node) => node.id === "go:internal/suites/example/compose/authelia/resources");
    expect(runtime?.label).toBe("Go resources");
    expect(runtime?.runtimeUnit).toBe("resources");
  });

  it("does not treat database/sql type imports as storage usage", () => {
    const inventory = collectArchitectureSignals(scope, [
      { path: "internal/model/types.go", content: 'import "database/sql"\ntype Config struct { Value sql.NullString }' },
    ]);
    expect(inventory.signals.some((signal) => signal.kind === "store")).toBe(false);
  });

  it("links module-root SQL initialization and recognizes SQLite as an HTTP-served database", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/writefreely" },
      { path: "cmd/writefreely/main.go", content: 'package main\nimport ("github.com/gorilla/mux"; "example.com/writefreely")\nfunc main() { r := mux.NewRouter(); writefreely.Serve(app, r) }' },
      { path: "app.go", content: 'package writefreely\nimport "database/sql"\nfunc init() { db, _ = sql.Open("sqlite3_with_regex", "writefreely.db") }' },
      { path: "database-sqlite.go", content: 'package writefreely\nimport "github.com/mattn/go-sqlite3"\nconst driverSQLite = "sqlite3"' },
      { path: "sqlite.sql", content: "CREATE TABLE users (id INTEGER PRIMARY KEY);" },
    ]);
    const runtime = analysis.facts.nodes.find((node) => node.id === "go:cmd/writefreely");
    expect(runtime?.kind).toBe("api");
    expect(runtime?.sourcePaths).toContain("app.go");
    expect(analysis.facts.nodes.some((node) => node.id === "store:sqlite")).toBe(true);
    expect(analysis.facts.nodes.some((node) => node.id === "store:mysql")).toBe(false);
    expect(analysis.facts.edges.some((edge) => edge.from === "go:cmd/writefreely" && edge.to === "store:sqlite" && edge.kind === "sql")).toBe(true);
    expect(analysis.coverage.publishable).toBe(true);
  });

  it("does not classify a generic CREATE TABLE statement as MySQL", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: "package main\nfunc main() {}" },
      { path: "schema.sql", content: "CREATE TABLE users (id INTEGER PRIMARY KEY);" },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "store:mysql")).toBe(false);
  });

  it("retains MySQL when a real MySQL driver is present", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport ("github.com/gorilla/mux"; "example.com/app")\nfunc main() { r := mux.NewRouter(); app.Serve(r) }' },
      { path: "app.go", content: 'package app\nimport ("database/sql"; "github.com/go-sql-driver/mysql")\nfunc init() { db, _ = sql.Open("mysql", "dsn") }' },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "store:mysql")).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.from === "go:cmd/app" && edge.to === "store:mysql" && edge.kind === "sql")).toBe(true);
  });
});
