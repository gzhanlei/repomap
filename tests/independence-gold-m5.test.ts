import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { runIndependenceMutations } from "../src/core/architecture/independence.js";
import { evaluateCriticalGold, type CriticalGoldSet } from "../src/core/architecture/gold.js";
import { evaluateArchitectureViews } from "../src/core/architecture/coverage-matrix.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const sources = [
  { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
  { path: "app/page.tsx", content: 'import { getProducts } from "../lib/shopify";\nexport default async function Page() { await getProducts(); }' },
  { path: "app/api/products/route.ts", content: 'export async function GET() { return Response.json({ ok: true }); }' },
  { path: "lib/shopify/index.ts", content: 'const endpoint = "https://api.example.com/graphql";\nexport async function getProducts() { return fetch(endpoint, { method: "POST", body: `query getProducts { products { id } }` }); }' },
];

describe("M5 independence mutations and critical gold", () => {
  it("retains independent denominators and reports missing facts after adapters are disabled", () => {
    const result = runIndependenceMutations(scope, sources);
    expect(result.passed).toBe(true);
    expect(result.cases.map((item) => item.id)).toEqual(expect.arrayContaining(["independent-declaration-inventory", "independent-module-import-denominator", "independent-route-denominator", "independent-async-denominator"]));
    expect(result.cases.every((item) => item.expected === item.retained)).toBe(true);
    expect(result.cases.some((item) => item.missing > 0)).toBe(true);
  });

  it("accepts a critical gold set with valid ids, directions and evidence", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const edge = analysis.ir.edges.find((item) => item.from === "actor:users" && item.to === "next:root:ui");
    const gold: CriticalGoldSet = {
      version: 1,
      revision,
      facts: [
        { id: "ui", kind: "node", expectedId: "next:root:ui", evidencePath: "app/page.tsx" },
        { id: "entry", kind: "edge", expectedId: edge!.id, direction: "outbound" },
      ],
      knownFalsePositiveIds: [],
    };
    expect(evaluateCriticalGold(analysis, gold).passed).toBe(true);
    expect(evaluateArchitectureViews(analysis, { gold }).fullArchitecture).toBe(true);
  });

  it("rejects missing gold facts and known false positives", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const missing: CriticalGoldSet = { version: 1, revision, facts: [{ id: "missing", kind: "node", expectedId: "next:does-not-exist" }], knownFalsePositiveIds: [] };
    const evaluation = evaluateCriticalGold(analysis, missing);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.missing).toContain("missing");
    expect(evaluateArchitectureViews(analysis, { gold: missing }).fullArchitecture).toBe(false);
    const falsePositive: CriticalGoldSet = { version: 1, revision, facts: [], knownFalsePositiveIds: ["next:root:ui"] };
    expect(evaluateCriticalGold(analysis, falsePositive).passed).toBe(false);
    expect(evaluateArchitectureViews(analysis, { gold: falsePositive }).fullArchitecture).toBe(false);
  });

  it("rejects an evidence path that does not support the expected fact", () => {
    const analysis = analyzeArchitectureFacts(scope, sources);
    const gold: CriticalGoldSet = { version: 1, revision, facts: [{ id: "ui", kind: "node", expectedId: "next:root:ui", evidencePath: "not-the-source.ts" }], knownFalsePositiveIds: [] };
    expect(evaluateCriticalGold(analysis, gold).evidenceInvalid.length).toBeGreaterThan(0);
    expect(evaluateArchitectureViews(analysis, { gold }).fullArchitecture).toBe(false);
  });
});
