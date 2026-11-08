import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSourceContentCache } from "../src/core/source/local.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";

describe("bounded lazy source content cache", () => {
  it("loads file content on demand and keeps the cache bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "repomap-cache-"));
    const a = join(root, "a.ts");
    const b = join(root, "b.ts");
    const c = join(root, "c.ts");
    await writeFile(a, "export const a = 1;\n");
    await writeFile(b, "export const b = 2;\n");
    await writeFile(c, "export const c = 3;\n");
    const cache = createSourceContentCache(2);
    expect(cache.read(a)).toContain("export const a = 1;");
    expect(cache.read(b)).toContain("export const b = 2;");
    expect(cache.read(a)).toContain("export const a = 1;");
    expect(cache.read(c)).toContain("export const c = 3;");
    expect(cache.read(a)).toContain("export const a = 1;");
    expect(cache.size).toBe(2);
  });

  it("preserves numbered source lines for lazy repository sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "repomap-cache-repo-"));
    await writeFile(join(root, "index.ts"), "const first = true;\nconst second = false;\n");
    const loaded = await loadLocalRepositorySources(root);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0].content).toBe("1: const first = true;\n2: const second = false;");
  });
});
