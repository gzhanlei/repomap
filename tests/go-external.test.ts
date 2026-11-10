import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { genericExternalCandidates } from "../src/core/architecture/detectors/generic-external.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

function candidates(sources: { path: string; content: string }[]) {
  return genericExternalCandidates({ ...scope, sources, signals: [] }).candidates;
}

describe("generic Go outbound HTTP", () => {
  it("resolves a static host from http.Get and links the calling runtime", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "net/http"\nfunc main() { http.Get("https://api.example.com/health") }' },
    ]);
    const external = analysis.candidates.find((candidate) => candidate.identity === "api.example.com");
    expect(external?.status).toBe("resolved");
    expect(external?.dynamic).toBe(false);
    expect(analysis.facts.edges.some((edge) => edge.from === "go:cmd/server" && edge.to === "external:api.example.com")).toBe(true);
    expect(analysis.coverage.metrics.external.covered).toBe(1);
    expect(analysis.coverage.publishable).toBe(true);
  });

  it("keeps a static host in the unified candidate path without provider aliases", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "net/http"\nfunc main() { http.Get("https://api.github.com/repos/example/demo") }' },
    ]);
    expect(analysis.facts.nodes.some((node) => node.id === "external:api.github.com")).toBe(true);
    expect(analysis.facts.nodes.some((node) => node.id === "external:github")).toBe(false);
    expect(analysis.candidates.some((candidate) => candidate.identity === "api.github.com" && candidate.status === "resolved")).toBe(true);
  });

  it("uses environment evidence for a dynamic Go endpoint", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "example.com/demo/internal/clients/payments"\nfunc main() { payments.Sync() }' },
      { path: "internal/clients/payments/client.go", content: 'package payments\nimport ("net/http"; "os")\nfunc Sync() { http.Get(os.Getenv("PAYMENTS_API_URL")) }' },
    ]);
    const external = analysis.candidates.find((candidate) => candidate.identity === "payments");
    expect(external?.status).toBe("resolved");
    expect(external?.dynamic).toBe(true);
    expect(analysis.facts.nodes.find((node) => node.id === "external:payments")?.label).toContain("动态 endpoint");
    expect(analysis.coverage.blockingOmissions).toEqual([]);
  });

  it("resolves client.Do through its NewRequest construction", () => {
    const found = candidates([
      { path: "internal/clients/activitypub/client.go", content: 'package activitypub\nfunc Send() {\n req, err := http.NewRequest("POST", target, nil)\n if err != nil { return }\n _, _ = c.HttpClient.Do(req)\n}' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].identity).toBe("activitypub");
    expect(found[0].dynamic).toBe(true);
    expect(found[0].operation?.name).toBe("post");
    expect(found[0].evidence.line).toBe(5);
    expect(found[0].evidence.detector).toBe("generic-go-http-call");
  });

  it("resolves constant URLs and keeps repeated request variables scoped by line", () => {
    const found = candidates([
      { path: "internal/clients/slack/client.go", content: 'package slack\nconst endpoint = "https://slack.com/api/oauth.access"\nfunc Exchange() {\n req, _ := http.NewRequest("POST", endpoint, nil)\n _, _ = c.HttpClient.Do(req)\n}\nfunc Inspect() {\n req, _ := http.NewRequest("GET", endpoint, nil)\n _, _ = c.HttpClient.Do(req)\n}' },
    ]);
    expect(found.map((candidate) => candidate.operation?.name)).toEqual(["post", "get"]);
    expect(found.every((candidate) => candidate.identity === "slack.com" && candidate.dynamic === false)).toBe(true);
  });

  it("uses protocol module names only as explicit dynamic identities", () => {
    const found = candidates([
      { path: "activitypub.go", content: 'package app\nfunc Send() {\n req, _ := http.NewRequest("POST", inboxURL, nil)\n _, _ = activityPubClient().Do(req)\n}' },
      { path: "oauth_gitea.go", content: 'package app\nfunc Exchange() {\n req, _ := http.NewRequest("POST", c.ExchangeLocation, nil)\n _, _ = c.HttpClient.Do(req)\n}' },
    ]);
    expect(found.map((candidate) => candidate.identity)).toEqual(["activitypub", "oauth-gitea"]);
    expect(found.every((candidate) => candidate.dynamic && candidate.status === "resolved")).toBe(true);
  });

  it("marks a static default as dynamic when environment configuration can override it", () => {
    const found = candidates([
      { path: "internal/clients/receipts/client.go", content: 'package receipts\nfunc Verify() {\n endpoint := os.Getenv("RECEIPTS_HOST")\n if endpoint == "" { endpoint = "https://webmonetization.org/api/receipts" }\n req, _ := http.NewRequest("POST", endpoint, nil)\n _, _ = http.DefaultClient.Do(req)\n}' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].identity).toBe("webmonetization.org");
    expect(found[0].dynamic).toBe(true);
  });

  it("does not treat request construction alone as a network call", () => {
    expect(candidates([
      { path: "internal/clients/payments/client.go", content: 'package payments\nfunc Build() {\n req, _ := http.NewRequest("GET", "https://api.example.com", nil)\n _ = req\n}' },
    ])).toEqual([]);
  });

  it("keeps an unknown dynamic identity as a blocking omission", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "net/http"\nfunc main() { http.Get(endpoint) }' },
    ]);
    expect(analysis.candidates.some((candidate) => candidate.identity === "unknown" && candidate.status === "omitted")).toBe(true);
    expect(analysis.coverage.publishable).toBe(false);
    expect(analysis.coverage.blockingOmissions.length).toBeGreaterThan(0);
  });

  it("ignores relative paths, comments, documentation strings and inbound servers", () => {
    const found = candidates([
      { path: "cmd/server/main.go", content: 'package main\n// http.Get("https://docs.example.com")\nvar documentation = "https://docs.example.com"\nfunc main() {\n http.Get("/health")\n http.ListenAndServe(":8080", nil)\n}' },
    ]);
    expect(found).toEqual([]);
  });
});
