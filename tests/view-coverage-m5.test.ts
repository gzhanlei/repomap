import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { evaluateArchitectureViews } from "../src/core/architecture/coverage-matrix.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const manifest = { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' };

function completeSources() {
  return [
    manifest,
    { path: "app/page.tsx", content: 'import { getProducts } from "../lib/shopify";\nexport default async function Page() { await getProducts(); }' },
    { path: "app/api/products/route.ts", content: 'export async function GET() { return Response.json({ ok: true }); }' },
    { path: "lib/shopify/index.ts", content: 'const endpoint = "https://api.example.com/graphql";\nexport async function getProducts() { return fetch(endpoint, { method: "POST", body: `query getProducts { products { id } }` }); }' },
  ];
}

describe("M5 independent view coverage and full gate", () => {
  it("allows full only when all four views and reconciliation pass", () => {
    const analysis = analyzeArchitectureFacts(scope, completeSources());
    const evaluation = evaluateArchitectureViews(analysis);
    for (const view of ["system-context", "runtime-overview", "module-architecture", "protocol-flows"] as const) {
      expect(evaluation.views[view].status).toBe("passed");
    }
    expect(evaluation.views["full-declared-scope"].status).toBe("passed");
    expect(evaluation.fullArchitecture).toBe(true);
  });

  it("blocks module/full for unresolved imports without changing runtime status", () => {
    const sources = completeSources();
    sources[1] = { path: "app/page.tsx", content: 'import "./missing";\nexport default function Page() {}' };
    const analysis = analyzeArchitectureFacts(scope, sources);
    const evaluation = evaluateArchitectureViews(analysis);
    expect(evaluation.views["runtime-overview"].status).toBe("passed");
    expect(evaluation.views["module-architecture"].status).toBe("failed");
    expect(evaluation.fullArchitecture).toBe(false);
  });

  it("blocks system/runtime/full for unknown external identities", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      manifest,
      { path: "app/page.tsx", content: 'import { call } from "../lib/utils";\nexport default async function Page() { await call(); }' },
      { path: "lib/utils/index.ts", content: 'export async function call() { return fetch(endpoint); }' },
    ]);
    const evaluation = evaluateArchitectureViews(analysis);
    expect(evaluation.views["system-context"].status).toBe("failed");
    expect(evaluation.views["runtime-overview"].status).toBe("failed");
    expect(evaluation.fullArchitecture).toBe(false);
  });

  it("does not allow protocol-flows with no operations", () => {
    const analysis = analyzeArchitectureFacts(scope, [manifest, { path: "app/page.tsx", content: "export default function Page() {}" }]);
    const evaluation = evaluateArchitectureViews(analysis);
    expect(evaluation.views["protocol-flows"].status).toBe("failed");
    expect(evaluation.fullArchitecture).toBe(false);
  });

  it("rejects a tampered projection even when the semantic facts pass", () => {
    const analysis = analyzeArchitectureFacts(scope, completeSources());
    const projection = { ...analysis.projection, totals: { ...analysis.projection.totals, hidden: analysis.projection.totals.hidden + 1 } };
    const evaluation = evaluateArchitectureViews(analysis, { projection });
    expect(evaluation.fullArchitecture).toBe(false);
    expect(evaluation.views["full-declared-scope"].blockingReasons.join(" ")).toContain("projection");
  });

  it("distinguishes dynamic disclosure from strict static-host requirements", () => {
    const sources = [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport ("net/http"; "example.com/demo/internal/clients/payments")\nfunc main() { payments.Sync(); http.ListenAndServe(":8080", nil) }' },
      { path: "internal/clients/payments/client.go", content: 'package payments\nimport ("net/http"; "os")\nfunc Sync() { http.Get(os.Getenv("PAYMENTS_API_URL")) }' },
    ];
    const analysis = analyzeArchitectureFacts(scope, sources);
    expect(evaluateArchitectureViews(analysis).views["runtime-overview"].status).toBe("passed");
    const strict = evaluateArchitectureViews(analysis, { strictExternalHosts: true });
    expect(strict.views["runtime-overview"].status).toBe("failed");
    expect(strict.fullArchitecture).toBe(false);
  });
});
