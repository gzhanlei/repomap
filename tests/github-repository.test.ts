import { describe, expect, it } from "vitest";
import { parseGitHubRepository, resolveGitHubRevision } from "../src/core/github/repository.js";
import { revision } from "./helpers.js";

describe("GitHub repository references", () => {
  it("parses shorthand and repository tree URLs", () => {
    expect(parseGitHubRepository("octo/demo")).toEqual({ owner: "octo", repo: "demo", revision: undefined });
    expect(parseGitHubRepository(`octo/demo@${revision}`)).toEqual({ owner: "octo", repo: "demo", revision });
    expect(parseGitHubRepository(`https://github.com/octo/demo/tree/${revision}`)).toEqual({ owner: "octo", repo: "demo", revision });
    expect(parseGitHubRepository("https://github.com/octo/demo.git")).toEqual({ owner: "octo", repo: "demo", revision: undefined });
    expect(parseGitHubRepository("https://example.com/octo/demo")).toBeUndefined();
    expect(parseGitHubRepository("not-a-repository")).toBeUndefined();
    expect(() => parseGitHubRepository("https://github.com/octo/demo/issues")).toThrow("GitHub URL");
  });

  it("uses a fixed revision without an API request and resolves HEAD once", async () => {
    await expect(resolveGitHubRevision({ owner: "octo", repo: "demo", revision })).resolves.toEqual({ revision, apiRequests: 0 });
    const fetcher = async (url: string | URL | Request) => Response.json({ sha: revision }, { status: String(url).includes("/commits/HEAD") ? 200 : 404 });
    await expect(resolveGitHubRevision({ owner: "octo", repo: "demo" }, { fetcher: fetcher as typeof fetch, token: "test-token" })).resolves.toEqual({ revision, apiRequests: 1 });
  });

  it("fails safely when GitHub cannot resolve HEAD", async () => {
    const fetcher = async () => new Response("rate limited", { status: 403 });
    await expect(resolveGitHubRevision({ owner: "octo", repo: "demo" }, { fetcher: fetcher as typeof fetch })).rejects.toThrow("GitHub API 403: rate limited");
  });
});
