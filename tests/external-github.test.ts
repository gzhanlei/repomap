import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("external evidence independent of provider path names", () => {
  it("detects GitHub API calls outside github-named paths", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: 'import { getRelease } from "../lib/client";\nexport default async function Page() { await getRelease(); }' },
      { path: "lib/client.ts", content: 'export async function getRelease() { return http.Get("https://api.github.com/repos/swagger-api/swagger-ui/releases/latest"); }' },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "external:github")).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.from === "next:root:ui" && edge.to === "external:github" && edge.kind === "http")).toBe(true);
  });
});
