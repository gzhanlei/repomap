import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { buildDeclarationInventory, evaluateDeclarationCoverage, mutationCheck } from "../src/core/architecture/declarations.js";
import { censusFromSources } from "../src/core/architecture/census.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

const nextSources = [
  { path: "package.json", content: '1: {"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
  { path: "app/page.tsx", content: "1: export default function Page() {}" },
  { path: "app/api/products/route.ts", content: "1: export async function GET() {}" },
];

describe("M0/M1 independent declarations and mutation harness", () => {
  it("keeps the independent denominator when every semantic extractor is disabled", () => {
    const analysis = analyzeArchitectureFacts(scope, nextSources);
    expect(analysis.declarations.declarations.length).toBeGreaterThan(0);
    expect(analysis.declarations.statistics.critical).toBeGreaterThan(0);
    expect(analysis.mutation.passed).toBe(true);
    expect(analysis.mutation.declarationsRetained).toBe(analysis.declarations.declarations.length);
    expect(analysis.mutation.mutatedMissing).toBeGreaterThan(0);
    expect(analysis.mutation.mutatedMissing).toBeGreaterThanOrEqual(analysis.mutation.baselineMissing);
  });

  it("discovers route/entrypoint declarations from raw structure without production detectors", () => {
    const census = censusFromSources(revision, nextSources);
    const inventory = buildDeclarationInventory({ revision, census, sources: nextSources });
    const kinds = new Set(inventory.declarations.map((item) => item.kind));
    expect(kinds.has("route")).toBe(true);
    expect(kinds.has("entrypoint")).toBe(true);
    expect(kinds.has("deployable")).toBe(true);
    expect(inventory.declarations.every((item) => item.declarationId.startsWith("decl:"))).toBe(true);
    expect(new Set(inventory.declarations.map((item) => item.declarationId)).size).toBe(inventory.declarations.length);
    expect(inventory.discovery).toBe("independent-structure-and-manifest-discovery");
  });

  it("reports missing critical declarations and blocks when facts are empty", () => {
    const census = censusFromSources(revision, nextSources);
    const inventory = buildDeclarationInventory({ revision, census, sources: nextSources });
    const coverage = evaluateDeclarationCoverage(inventory, { nodes: [], edges: [] });
    expect(coverage.total).toBeGreaterThan(0);
    expect(coverage.covered).toBe(0);
    expect(coverage.missing.length).toBe(coverage.total);
    expect(coverage.blocking).toBe(true);
    expect(mutationCheck(inventory, { nodes: [], edges: [] }).passed).toBe(true);
  });

  it("reports unknown frameworks and unsupported protocols as capability gaps", () => {
    const sources = [
      { path: "package.json", content: '1: {"dependencies":{"mystery-framework":"1.0.0"}}' },
      { path: "src/grpc-client.ts", content: '1: import { Client } from "@grpc/grpc-js";' },
      { path: "src/socket.ts", content: '1: const socket = new WebSocket("wss://example.test");' },
    ];
    const analysis = analyzeArchitectureFacts(scope, sources);
    expect(analysis.declarations.capabilityGaps.some((gap) => gap.startsWith("unsupported-framework:"))).toBe(true);
    expect(analysis.declarations.protocolGaps).toContain("unsupported-protocol:grpc");
    expect(analysis.declarations.protocolGaps).toContain("unsupported-protocol:websocket");
    expect(analysis.omissions.some((omission) => omission.reason === "unsupported-protocol" && omission.blocking)).toBe(true);
    expect(analysis.omissions.some((omission) => omission.reason === "unsupported-framework")).toBe(true);
  });

  it("does not let a generic network candidate replace protocol operation coverage", () => {
    const sources = [
      { path: "package.json", content: '1: {"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
      { path: "src/grpc-client.ts", content: '1: import { Client } from "@grpc/grpc-js";' },
    ];
    const analysis = analyzeArchitectureFacts(scope, sources);
    expect(analysis.ir.operations).toEqual([]);
    expect(analysis.omissions.some((omission) => omission.reason === "unsupported-protocol" && omission.affectedViews.includes("full-declared-scope"))).toBe(true);
    expect(analysis.declarationCoverage.blockingViews).toContain("protocol-flows");
    expect(analysis.declarationCoverage.blockingViews).not.toContain("runtime-overview");
  });
});
