import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("generic package deployable ownership", () => {
  it("covers a package start declaration with process evidence without inferring a web service", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "docs/package.json", content: '{"scripts":{"start":"hugo server --disableFastRender"}}' },
    ]);
    const runtime = analysis.facts.nodes.find((node) => node.id === "package:docs:deployable");
    expect(runtime).toMatchObject({ kind: "cli", runtimeUnit: "docs", sourcePaths: ["docs/package.json"] });
    expect(analysis.facts.edges.some((edge) => edge.from === "actor:cli-users" && edge.to === runtime?.id && edge.kind === "process")).toBe(true);
    expect(analysis.declarationCoverage.missing).toEqual([]);
    expect(analysis.coverage.publishable).toBe(true);
  });

  it("does not duplicate a Next.js runtime that already owns its package manifest", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: "export default function Page() {}" },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "next:root:ui" && node.sourcePaths?.includes("package.json"))).toBe(true);
    expect(analysis.facts.nodes.some((node) => node.id === "package:root:deployable")).toBe(false);
    expect(analysis.declarationCoverage.missing).toEqual([]);
  });
});
