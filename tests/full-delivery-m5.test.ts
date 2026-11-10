import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { deliveryExitCode } from "../src/core/architecture/scope.js";
import { revision } from "./helpers.js";

const manifest = { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' };
const sources = [
  manifest,
  { path: "app/page.tsx", content: 'import { getProducts } from "../lib/shopify";\nexport default async function Page() { await getProducts(); }' },
  { path: "app/api/products/route.ts", content: 'export async function GET() { return Response.json({ ok: true }); }' },
  { path: "lib/shopify/index.ts", content: 'const endpoint = "https://api.example.com/graphql";\nexport async function getProducts() { return fetch(endpoint, { method: "POST", body: `query getProducts { products { id } }` }); }' },
];

describe("M5 full delivery gate", () => {
  it("sets fullArchitecture only for a passing full request", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-full-pass-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources,
      sourceReceipt: { scope: "repository", directories: 4, files: sources.length, bytes: 500 },
      outDir,
      requestedViews: ["full"],
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.fullArchitecture).toBe(true);
    expect(receipt.delivery.fullArchitecture).toBe(true);
    expect(receipt.delivery.views.find((entry) => entry.view === "full-declared-scope")?.status).toBe("facts-ready");
    expect(deliveryExitCode(receipt.delivery)).toBe(0);
  });

  it("fails the overall delivery when full is requested but a dependent view fails", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-full-fail-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: [manifest, { path: "app/page.tsx", content: 'import "./missing";\nexport default function Page() {}' }],
      sourceReceipt: { scope: "repository", directories: 2, files: 2, bytes: 100 },
      outDir,
      requestedViews: ["full"],
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.delivery.views.find((entry) => entry.view === "runtime-overview")?.status).toBe("facts-ready");
    expect(receipt.delivery.views.find((entry) => entry.view === "module-architecture")?.status).toBe("failed");
    expect(receipt.delivery.views.find((entry) => entry.view === "full-declared-scope")?.status).toBe("failed");
    expect(deliveryExitCode(receipt.delivery)).toBe(1);
  });

  it("does not mark an ordinary runtime request as full", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-runtime-not-full-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources,
      sourceReceipt: { scope: "repository", directories: 4, files: sources.length, bytes: 500 },
      outDir,
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.fullArchitecture).toBe(false);
    expect(receipt.delivery.views.find((entry) => entry.view === "full-declared-scope")?.status).toBe("not-requested");
  });
});
