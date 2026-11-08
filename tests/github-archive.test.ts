import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as tar from "tar";
import { loadGitHubRepositorySources } from "../src/core/github/archive.js";
import { nextFixture, revision } from "./helpers.js";

async function archiveFixture() {
  const fixture = await nextFixture();
  const pack = tar.c({ cwd: dirname(fixture), gzip: true }, [basename(fixture)]);
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  return { fixture, archive: Buffer.concat(chunks) };
}

describe("GitHub archive source loading", () => {
  it("downloads one fixed-SHA archive and reuses it without network on the second run", async () => {
    const { fixture, archive } = await archiveFixture();
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(archive, { status: 200, headers: { "content-length": String(archive.byteLength) } }));
    const options = { fetcher: fetcher as typeof fetch, cacheDir: join(fixture, "cache") };
    const first = await loadGitHubRepositorySources({ owner: "octo", repo: "demo", revision }, options);
    expect(first.repository).toEqual({ owner: "octo", repo: "demo", revision });
    expect(first.sources.map((source) => source.path)).toContain("app/page.tsx");
    expect(first.archive).toMatchObject({ cacheHit: false, httpRequests: 1, bytes: archive.byteLength });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://codeload.github.com/octo/demo/tar.gz/${revision}`);

    const second = await loadGitHubRepositorySources({ owner: "octo", repo: "demo", revision }, options);
    expect(second.archive.cacheHit).toBe(true);
    expect(second.archive.httpRequests).toBe(0);
    expect(second.sources).toEqual(first.sources);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("can bypass the archive cache", async () => {
    const { fixture, archive } = await archiveFixture();
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(archive));
    await loadGitHubRepositorySources({ owner: "octo", repo: "demo", revision }, { fetcher: fetcher as typeof fetch, useCache: false, cacheDir: join(fixture, "cache") });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
