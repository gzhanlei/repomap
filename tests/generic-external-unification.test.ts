import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const next = { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' };

describe("M3 unified external candidates", () => {
  it("keeps object-storage upload/download operations without a provider-specific external detector", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      next,
      { path: "app/page.tsx", content: 'import { upload } from "../lib/cos/client";\nexport default function Page() { void upload(); }' },
      { path: "lib/cos/client.ts", content: 'const client = NewQCloudClient(config);\nexport function upload() { return client.PresignPut(request); }\nexport function download() { return client.PresignGet(request); }' },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "store:cos" && node.kind === "object-store")).toBe(true);
    expect(analysis.candidates.map((candidate) => candidate.operation?.kind)).toEqual(expect.arrayContaining(["upload", "download"]));
    expect(analysis.facts.edges.some((edge) => edge.to === "store:cos" && edge.kind === "upload")).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.to === "store:cos" && edge.kind === "download")).toBe(true);
  });

  it("keeps local process integrations in the same candidate inventory", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      next,
      { path: "app/page.tsx", content: 'import { render } from "../lib/archify/client";\nexport default function Page() { void render(); }' },
      { path: "lib/archify/client.ts", content: 'export async function render() { return deliverArchify(input); }' },
    ]);
    expect(analysis.candidates.some((candidate) => candidate.identity === "archify" && candidate.operation?.kind === "process")).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.to === "external:archify" && edge.kind === "process")).toBe(true);
  });

  it("represents an inbound webhook as a callback candidate and edge", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      next,
      { path: "app/api/webhooks/github/route.ts", content: 'export async function POST(request: Request) {\n const event = request.headers.get("x-github-event"); if (event === "push") return Response.json({ ok: true });\n}' },
    ]);
    expect(analysis.candidates.some((candidate) => candidate.identity === "github" && candidate.operation?.kind === "callback")).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.from === "external:github" && edge.to === "next:root:api" && edge.kind === "callback")).toBe(true);
    expect(analysis.facts.roots).toContain("external:github");
  });
});
