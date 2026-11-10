import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("M4 target and configuration resolution", () => {
  it("represents a required environment endpoint without inventing a default host", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "example.com/demo/internal/clients/payments"\nfunc main() { payments.Sync() }' },
      { path: "internal/clients/payments/client.go", content: 'package payments\nimport ("net/http"; "os")\nfunc Sync() { http.Get(os.Getenv("PAYMENTS_API_URL")) }' },
    ]);
    const candidate = analysis.candidates.find((item) => item.identity === "payments");
    expect(candidate?.target).toMatchObject({ kind: "service", resolution: "configured", configKey: "PAYMENTS_API_URL" });
    expect(candidate?.target?.defaultValue).toBeUndefined();
    expect(analysis.ir.operations.some((operation) => operation.kind === "config-binding" && operation.configKey === "PAYMENTS_API_URL" && operation.defaultValue === "")).toBe(true);
  });

  it("keeps a static default and its environment override in one configured target", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "example.com/demo/internal/clients/receipts"\nfunc main() { receipts.Verify() }' },
      { path: "internal/clients/receipts/client.go", content: 'package receipts\nfunc Verify() {\n endpoint := os.Getenv("RECEIPTS_HOST")\n if endpoint == "" { endpoint = "https://webmonetization.org/api/receipts" }\n req, _ := http.NewRequest("POST", endpoint, nil)\n _, _ = http.DefaultClient.Do(req)\n}' },
    ]);
    const candidate = analysis.candidates.find((item) => item.identity === "webmonetization.org");
    expect(candidate?.target).toMatchObject({ kind: "host", resolution: "configured", configKey: "RECEIPTS_HOST", defaultValue: "https://webmonetization.org/api/receipts" });
    expect(candidate?.dynamic).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "config-binding" && operation.configKey === "RECEIPTS_HOST" && operation.defaultValue.includes("webmonetization.org"))).toBe(true);
  });

  it("distinguishes a dynamic protocol target from a concrete host", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "activitypub.go", content: 'package app\nfunc Send() {\n req, _ := http.NewRequest("POST", inboxURL, nil)\n _, _ = activityPubClient().Do(req)\n}' },
    ]);
    const candidate = analysis.candidates.find((item) => item.identity === "activitypub");
    expect(candidate?.target).toMatchObject({ kind: "protocol", resolution: "dynamic" });
  });

  it("marks unknown egress as unknown instead of configured", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport "net/http"\nfunc main() { http.Get(endpoint) }' },
    ]);
    expect(analysis.candidates[0]?.target).toMatchObject({ kind: "unknown", resolution: "unknown" });
  });

  it("resolves cross-file default hosts and receiver field configuration", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "oauth_writeas.go", content: 'package app\nconst writeAsExchangeLocation = "https://write.as/oauth/token"\nfunc (c writeAsOauthClient) exchange() {\n req, _ := http.NewRequest("POST", c.ExchangeLocation, nil)\n _, _ = c.HttpClient.Do(req)\n}' },
      { path: "oauth_gitlab.go", content: 'package app\nconst gitlabHost = "https://gitlab.com"\nfunc (c gitlabOauthClient) exchange() {\n req, _ := http.NewRequest("POST", c.ExchangeLocation, nil)\n _, _ = c.HttpClient.Do(req)\n}' },
      { path: "oauth_gitea.go", content: 'package app\nfunc (c giteaOauthClient) exchange() {\n req, _ := http.NewRequest("POST", c.ExchangeLocation, nil)\n _, _ = c.HttpClient.Do(req)\n}' },
      { path: "oauth.go", content: 'package app\nfunc configure() {\n oauthClient := writeAsOauthClient{\n ExchangeLocation: config.OrDefaultString(app.Config().WriteAsOauth.TokenLocation, writeAsExchangeLocation),\n }\n address := config.OrDefaultString(app.Config().GitlabOauth.Host, gitlabHost)\n gitlabClient := gitlabOauthClient{\n ExchangeLocation: address + "/oauth/token",\n }\n giteaClient := giteaOauthClient{\n ExchangeLocation: app.Config().GiteaOauth.Host + "/login/oauth/access_token",\n }\n}' },
    ]);
    const writeAs = analysis.candidates.find((item) => item.identity === "write.as");
    expect(writeAs?.target).toMatchObject({ kind: "host", resolution: "configured", configKey: "WriteAsOauth.TokenLocation", defaultValue: "https://write.as/oauth/token" });
    const gitlab = analysis.candidates.find((item) => item.identity === "gitlab.com");
    expect(gitlab?.target).toMatchObject({ kind: "host", resolution: "configured", configKey: "GitlabOauth.Host", defaultValue: "https://gitlab.com" });
    const gitea = analysis.candidates.find((item) => item.identity === "oauth-gitea");
    expect(gitea?.target).toMatchObject({ kind: "protocol", resolution: "configured", configKey: "GiteaOauth.Host" });
  });

  it("allows disclosed dynamic targets by default but fails the strict host gate", async () => {
    const sources = [
      { path: "go.mod", content: "module example.com/demo" },
      { path: "cmd/server/main.go", content: 'package main\nimport ("net/http"; "example.com/demo/internal/clients/payments")\nfunc main() { payments.Sync(); http.ListenAndServe(":8080", nil) }' },
      { path: "internal/clients/payments/client.go", content: 'package payments\nimport ("net/http"; "os")\nfunc Sync() { http.Get(os.Getenv("PAYMENTS_API_URL")) }' },
    ];
    const sourceReceipt = { scope: "repository" as const, directories: 3, files: sources.length, bytes: 500 };
    const identity = { kind: "local" as const, owner: "local", repo: "demo", revision };
    const normalOut = await mkdtemp(join(tmpdir(), "repomap-target-normal-"));
    const normal = await analyzeSources({ identity, sources, sourceReceipt, outDir: normalOut, render: false, deliver: vi.fn() });
    expect(normal.status).toBe("facts-ready");
    const strictOut = await mkdtemp(join(tmpdir(), "repomap-target-strict-"));
    const strict = await analyzeSources({ identity, sources, sourceReceipt, outDir: strictOut, render: false, strictExternalHosts: true, deliver: vi.fn() });
    expect(strict).toMatchObject({ status: "failed", error: expect.stringContaining("External hosts") });
    expect(strict.fullArchitecture).toBe(false);
  });
});
