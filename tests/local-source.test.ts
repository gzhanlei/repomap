import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isSupportedRepositoryPath, loadLocalRepositorySources, verifyLocalGitRevision } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

describe("local repository source loading", () => {
  it("loads complete numbered runtime sources in deterministic order", async () => {
    const root = await nextFixture();
    await mkdir(join(root, "node_modules/dependency"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "node_modules/dependency/index.js"), "ignored");
    await writeFile(join(root, "tests/page.test.ts"), "ignored");
    await mkdir(join(root, "public"), { recursive: true });
    await writeFile(join(root, "public/logo.png"), "ignored");
    const loaded = await loadLocalRepositorySources(root);
    expect(loaded.sources.map((source) => source.path)).toEqual(["app/api/products/route.ts", "app/page.tsx", "package.json"]);
    expect(loaded.sources[1].content).toBe("1: export default function Page() {}");
    expect(loaded.receipt).toMatchObject({ scope: "repository", files: 3 });
    expect(loaded.receipt.bytes).toBeGreaterThan(0);
    expect(loaded.receipt.directories).toBeGreaterThan(1);
  });

  it("fails closed for file and byte budgets", async () => {
    const root = await nextFixture();
    await expect(loadLocalRepositorySources(root, { maxFiles: 1 })).rejects.toThrow("file budget exhausted");
    await expect(loadLocalRepositorySources(root, { maxTotalBytes: 10 })).rejects.toThrow("byte budget exhausted");
    await expect(loadLocalRepositorySources(root, { maxDirectories: 1 })).rejects.toThrow("directory budget exhausted");
  });

  it("verifies a clean local Git revision and rejects mismatches or dirty trees", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    await expect(verifyLocalGitRevision("/tmp/repo", revision, runner)).resolves.toBeUndefined();
    expect(runner).toHaveBeenNthCalledWith(1, "git", ["-C", "/tmp/repo", "rev-parse", "HEAD"], expect.anything());
    await expect(verifyLocalGitRevision("/tmp/repo", revision, vi.fn(async () => ({ stdout: "a".repeat(40), stderr: "" })))).rejects.toThrow("does not match");
    const dirty = vi.fn().mockResolvedValueOnce({ stdout: revision, stderr: "" }).mockResolvedValueOnce({ stdout: " M app/page.tsx", stderr: "" });
    await expect(verifyLocalGitRevision("/tmp/repo", revision, dirty)).rejects.toThrow("dirty");
    await expect(verifyLocalGitRevision("/tmp/repo", revision, vi.fn(async () => { throw new Error("not git"); }))).rejects.toThrow("Git work tree");
  });

  it("filters unsafe and non-runtime paths", () => {
    expect(isSupportedRepositoryPath("app/page.tsx")).toBe(true);
    expect(isSupportedRepositoryPath("../secret.ts")).toBe(false);
    expect(isSupportedRepositoryPath("tests/page.test.ts")).toBe(false);
    expect(isSupportedRepositoryPath("public/logo.png")).toBe(false);
  });
});
