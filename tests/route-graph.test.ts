import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { createUnavailableAdapter } from "../src/core/architecture/project/adapter.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
const next = { path: "package.json", content: '{"scripts":{"start":"next start"},"dependencies":{"next":"16.0.0"}}' };

describe("M3 route and bounded handler call graph", () => {
  it("resolves a Next.js re-export alias and emits an HTTP operation", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      next,
      { path: "app/api/products/[id]/route.ts", content: 'export { GET as POST } from "../../../../lib/products/handlers";' },
      { path: "lib/products/handlers.ts", content: 'export async function GET() { return Response.json({ ok: true }); }' },
    ]);
    const graph = analysis.routeGraph;
    const route = graph.routes.find((item) => item.method === "POST" && item.path === "/api/products/[id]");
    expect(route).toBeDefined();
    const handler = graph.handlers.find((item) => item.name === "GET");
    expect(handler).toMatchObject({ sourcePath: "lib/products/handlers.ts", resolution: "re-export" });
    expect(graph.edges.some((edge) => edge.from === route?.id && edge.to === handler?.id && edge.kind === "routes-to")).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "http" && operation.method === "POST" && operation.path === "/api/products/[id]")).toBe(true);
  });

  it("links a local Next handler's direct imported call to the target module", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      next,
      { path: "app/api/products/route.ts", content: 'import { getProducts } from "../../../lib/shopify";\nexport async function GET() { return getProducts(); }' },
      { path: "lib/shopify/index.ts", content: 'export async function getProducts() { return fetch("https://api.example.com/products"); }' },
    ]);
    const graph = analysis.routeGraph;
    expect(graph.calls.some((call) => call.to === "lib/shopify/index.ts" && call.toKind === "module" && call.kind === "calls")).toBe(true);
  });

  it("resolves Go HandleFunc package handlers and direct internal package calls", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/shop" },
      { path: "cmd/server/main.go", content: 'package main\nimport ("net/http"; "example.com/shop/internal/handlers")\nfunc main() { http.HandleFunc("/products", handlers.ListProducts); http.ListenAndServe(":8080", nil) }' },
      { path: "internal/handlers/products.go", content: 'package handlers\nimport "example.com/shop/internal/store"\nfunc ListProducts() { store.List() }' },
      { path: "internal/store/store.go", content: 'package store\nfunc List() {}' },
    ]);
    const graph = analysis.routeGraph;
    const route = graph.routes.find((item) => item.path === "/products" && item.framework === "go-http");
    expect(route).toBeDefined();
    const handler = graph.handlers.find((item) => item.name === "ListProducts");
    expect(handler).toMatchObject({ sourcePath: "internal/handlers/products.go", resolution: "package" });
    expect(graph.calls.some((call) => call.to === "go-package:internal/store:store" && call.toKind === "package")).toBe(true);
  });

  it("resolves uppercase router methods, middleware factories and Path.Handler chains", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/shop" },
      { path: "cmd/server/main.go", content: 'package main\nimport ("example.com/shop/internal/handlers"; "example.com/shop/internal/oidc")\nfunc main() {\n r.GET("/api/health", middlewareAPI(handlers.HealthGET))\n r.POST("/api/first", middleware1FA(handlers.FirstFactorPOST(delayerPassword)))\n me.Path("/delete").Handler(csrf.Protect(key)(handler.User(handleUserDelete))).Methods("POST")\n r.GET(oidc.EndpointPathToken, bridge(handlers.TokenGET))\n}' },
      { path: "internal/handlers/products.go", content: 'package handlers\nfunc HealthGET() {}\nfunc FirstFactorPOST() {}\nfunc TokenGET() {}' },
      { path: "internal/oidc/const.go", content: 'package oidc\nconst EndpointPathToken = "/api/oidc/token"' },
      { path: "cmd/server/delete.go", content: 'package main\nfunc handleUserDelete() {}' },
    ]);
    const graph = analysis.routeGraph;
    expect(graph.handlers.some((handler) => handler.name === "HealthGET" && handler.resolution === "package")).toBe(true);
    expect(graph.handlers.some((handler) => handler.name === "FirstFactorPOST" && handler.resolution === "package")).toBe(true);
    expect(graph.handlers.some((handler) => handler.name === "handleUserDelete" && handler.resolution === "local")).toBe(true);
    expect(graph.handlers.some((handler) => handler.name === "TokenGET" && handler.resolution === "package")).toBe(true);
    expect(graph.routes.some((route) => route.path === "/delete" && route.method === "POST")).toBe(true);
    expect(graph.routes.some((route) => route.path === "oidc.EndpointPathToken")).toBe(true);
    expect(graph.routes.some((route) => route.path === "/")).toBe(false); // csrf.Path is not a router registration
  });

  it("keeps every method and every route/call evidence reference", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/shop" },
      { path: "cmd/server/main.go", content: 'package main\nimport "example.com/shop/internal/handlers"\nfunc main() { r.HandleFunc("/items", handlers.List).Methods("POST", "DELETE") }' },
      { path: "internal/handlers/items.go", content: 'package handlers\nfunc List() {}' },
    ]);
    const graph = analysis.routeGraph;
    expect(graph.routes.map((route) => route.method).sort()).toEqual(["DELETE", "POST"]);
    const indexed = new Set(analysis.evidence.records.map((record) => record.id));
    for (const owner of [...graph.routes, ...graph.handlers, ...graph.edges, ...graph.calls]) {
      for (const id of owner.evidenceIds) expect(indexed.has(id)).toBe(true);
    }
  });

  it("resolves a Vite React Router route to its component module", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"vite"},"dependencies":{"react":"19.0.0","react-router-dom":"7.0.0"}}' },
      { path: "vite.config.ts", content: 'import { defineConfig } from "vite"; export default defineConfig({});' },
      { path: "src/main.tsx", content: 'import { createBrowserRouter } from "react-router-dom";\nimport Home from "./Home";\nexport const router = createBrowserRouter([{ path: "/", element: <Home /> }]);' },
      { path: "src/Home.tsx", content: 'export default function Home() { return <main>Home</main>; }' },
    ]);
    const graph = analysis.routeGraph;
    const route = graph.routes.find((item) => item.path === "/" && item.framework === "vite-react-router");
    expect(route).toBeDefined();
    expect(graph.handlers.some((handler) => handler.name === "Home" && handler.sourcePath === "src/Home.tsx")).toBe(true);
  });

  it("keeps an unresolved Go handler in the independent denominator and blocks dependent views", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/shop" },
      { path: "cmd/server/main.go", content: 'package main\nimport "net/http"\nfunc main() { http.HandleFunc("/broken", missingHandler); http.ListenAndServe(":8080", nil) }' },
    ], { adapters: [createUnavailableAdapter("ast-go", ["go"], "simulated missing grammar")] });
    expect(analysis.routeGraph.coverage.expected).toBeGreaterThan(0);
    expect(analysis.routeGraph.coverage.missing.length).toBeGreaterThan(0);
    expect(analysis.routeGraph.gates.blockedViews).toContain("full-declared-scope");
    expect(analysis.routeGraph.gates.runtimeOverviewUnaffected).toBe(true);
    expect(analysis.routeGraph.omissions.some((omission) => omission.reason === "unresolved-handler" || omission.reason === "parser-unavailable")).toBe(true);
  });
});
