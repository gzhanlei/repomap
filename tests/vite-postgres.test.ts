import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { collectArchitectureSignals } from "../src/core/architecture/signals.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("Vite, PostgreSQL and CI boundaries", () => {
  it("recognizes Vite/React entrypoints and package deployability", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "web/package.json", content: '{"scripts":{"start":"vite --host"},"dependencies":{"react":"19.0.0"}}' },
      { path: "web/vite.config.ts", content: 'import { defineConfig } from "vite";\nexport default defineConfig({});' },
      { path: "web/src/App.tsx", content: 'export default function App() { return <main>Authelia</main>; }' },
      { path: "web/src/index.tsx", content: 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);' },
    ]);
    const frontend = analysis.facts.nodes.find((node) => node.id === "vite:web:ui");
    expect(frontend).toBeDefined();
    expect(frontend?.kind).toBe("frontend");
    expect(frontend?.sourcePaths).toContain("web/src/App.tsx");
    expect(analysis.facts.roots).toContain("actor:users");
    expect(analysis.coverage.publishable).toBe(true);
  });

  it("recognizes a root Vite app without absorbing nested package entrypoints", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"vite"},"dependencies":{"react":"19.0.0"}}' },
      { path: "vite.config.ts", content: 'import { defineConfig } from "vite"; export default defineConfig({});' },
      { path: "src/main.tsx", content: 'import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")!).render(null);' },
      { path: "web/src/main.tsx", content: 'import { createRoot } from "react-dom/client"; createRoot(document.getElementById("web")!).render(null);' },
    ]);
    const frontend = analysis.facts.nodes.find((node) => node.id === "vite:root:ui");
    expect(frontend?.label).toBe("Vite Web UI");
    expect(frontend?.runtimeUnit).toBe("vite-root");
    expect(frontend?.sourcePaths).toContain("src/main.tsx");
    expect(frontend?.sourcePaths).not.toContain("web/src/main.tsx");
  });

  it("recognizes PostgreSQL storage and startup evidence in the import closure", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/authelia" },
      { path: "cmd/authelia/main.go", content: 'package main\nimport "example.com/authelia/internal/commands"\nfunc main() { commands.NewRootCmd().Execute() }' },
      { path: "internal/commands/root.go", content: 'package commands\nfunc RootRunE() { service.RunAll(ctx) }' },
      { path: "internal/storage/migrations/postgres/V0001.Initial_Schema.up.sql", content: "CREATE TABLE users (id TEXT PRIMARY KEY);" },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "go:cmd/authelia" && node.kind === "api")).toBe(true);
    expect(analysis.facts.nodes.some((node) => node.id === "store:postgres")).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.from === "go:cmd/authelia" && edge.to === "store:postgres" && edge.kind === "sql")).toBe(true);
    expect(analysis.coverage.publishable).toBe(true);
  });

  it("does not treat CI schedules as runtime workers", () => {
    const inventory = collectArchitectureSignals(scope, [
      { path: ".github/workflows/codeql-analysis.yml", content: "on:\n  schedule:\n    - cron: '25 13 * * 3'" },
    ]);
    expect(inventory.signals.some((signal) => signal.kind === "worker")).toBe(false);
  });
});
