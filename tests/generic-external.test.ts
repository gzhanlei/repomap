import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { isArchitectureSourcePath } from "../src/core/architecture/source.js";
import { layoutArchitecture } from "../src/core/architecture/layout.js";
import { analyzeSources } from "../src/core/analyze.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("generic external protocol detection", () => {
  it("filters generated third-party bundles without excluding real source", () => {
    expect(isArchitectureSourcePath("static/js/mathjax/tex-svg-full.js")).toBe(false);
    expect(isArchitectureSourcePath("public/assets/plotly/plotly-full.js")).toBe(false);
    expect(isArchitectureSourcePath("src/mathjax/index.ts")).toBe(true);
    expect(isArchitectureSourcePath("static/js/ace.js")).toBe(false);
    expect(isArchitectureSourcePath("static/js/app.js")).toBe(true);
  });

  it("keeps the external resource lane within the desktop readability width", () => {
    const components = [
      { id: "ui", type: "frontend" as const, label: "Web UI", pos: [Number.NaN, Number.NaN] as [number, number], size: [200, 64] as [number, number] },
      { id: "api", type: "backend" as const, label: "API", pos: [Number.NaN, Number.NaN] as [number, number], size: [200, 64] as [number, number] },
      { id: "external:shopify", type: "external" as const, label: "shopify（动态 endpoint）", pos: [Number.NaN, Number.NaN] as [number, number], size: [204, 64] as [number, number] },
    ];
    const roles = new Map([["ui", "frontend" as const], ["api", "api" as const], ["external:shopify", "external" as const]]);
    const layout = layoutArchitecture(components, [], roles, new Set());
    expect(layout.viewBox[0]).toBe(1204);
  });

  it("resolves dynamic GraphQL services and operation directions without a provider detector", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: 'import { getProducts } from "../lib/shopify/index";\nexport default async function Page() { await getProducts(); }' },
      { path: "lib/shopify/index.ts", content: 'const domain = process.env.SHOPIFY_STORE_DOMAIN;\nconst endpoint = `${domain}/graphql`;\nexport async function shopifyFetch(query: string) { return fetch(endpoint, { method: "POST" }); }\nexport { getProducts } from "./queries/product";\nexport { createCart } from "./mutations/cart"; }' },
      { path: "lib/shopify/queries/product.ts", content: 'export const getProductsQuery = /* GraphQL */ `query getProducts { products { id } }`;' },
      { path: "lib/shopify/mutations/cart.ts", content: 'export const createCartMutation = /* GraphQL */ `mutation cartCreate { cartCreate { id } }`;' },
    ]);
    const shopify = analysis.facts.nodes.find((node) => node.id === "external:shopify");
    expect(shopify).toBeDefined();
    expect(shopify?.label).toContain("动态 endpoint");
    expect(analysis.facts.edges.some((edge) => edge.from === "next:root:ui" && edge.to === "external:shopify" && edge.kind === "download" && edge.label.includes("getProducts"))).toBe(true);
    expect(analysis.facts.edges.some((edge) => edge.from === "next:root:ui" && edge.to === "external:shopify" && edge.kind === "upload" && edge.label.includes("cartCreate"))).toBe(true);
    expect(analysis.candidates.some((candidate) => candidate.protocol === "graphql" && candidate.operation?.name === "getProducts" && candidate.status === "resolved")).toBe(true);
    expect(analysis.coverage.publishable).toBe(true);
  });

  it("uses an absolute HTTPS host as a static external identity", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: 'export default async function Page() { await fetch("https://api.stripe.com/v1/charges", { method: "POST" }); }' },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "external:api.stripe.com" && node.label === "api.stripe.com")).toBe(true);
    expect(analysis.candidates.some((candidate) => candidate.identity === "api.stripe.com" && !candidate.dynamic)).toBe(true);
  });

  it("fails closed when an external identity cannot be established", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' },
      { path: "app/page.tsx", content: 'import { call } from "../lib/utils/index";\nexport default async function Page() { await call(); }' },
      { path: "lib/utils/index.ts", content: 'export async function call() { return fetch(endpoint); }' },
    ]);
    expect(analysis.candidates.some((candidate) => candidate.status === "omitted" && candidate.identity === "unknown")).toBe(true);
    expect(analysis.facts.omissions.length).toBeGreaterThan(0);
    expect(analysis.coverage.publishable).toBe(false);
    expect(analysis.coverage.blockingOmissions.length).toBeGreaterThan(0);
  });

  it("writes the candidate inventory alongside facts for Harness follow-up", async () => {
    const root = await nextFixture();
    await mkdir(join(root, "lib/shopify/queries"), { recursive: true });
    await writeFile(join(root, "lib/shopify/index.ts"), 'const endpoint = `${process.env.SHOPIFY_STORE_DOMAIN}/graphql`;\nexport async function shopifyFetch(query: string) { return fetch(endpoint); }\nexport { getProducts } from "./queries/product";');
    await writeFile(join(root, "lib/shopify/queries/product.ts"), 'export const getProductsQuery = /* GraphQL */ `query getProducts { products { id } }`;');
    const loaded = await loadLocalRepositorySources(root);
    const outDir = join(root, "out");
    const receipt = await analyzeSources({ identity: { kind: "local", owner: "local", repo: "demo", revision }, sources: loaded.sources, sourceReceipt: loaded.receipt, outDir, render: false });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.outputs).toHaveProperty("candidates");
    const candidates = JSON.parse(await readFile(join(outDir, "architecture.candidates.json"), "utf8"));
    expect(candidates.candidates.some((candidate: { identity: string; protocol: string }) => candidate.identity === "shopify" && candidate.protocol === "graphql")).toBe(true);
  });
});
