import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../src/core/json.js";

describe("streaming atomic JSON output", () => {
  it("writes large JSON with normal undefined semantics and no temporary leftovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "repomap-json-"));
    const path = join(root, "evidence.json");
    await writeFile(path, "old content");
    const value = {
      records: Array.from({ length: 10_000 }, (_, index) => ({ id: `ev:${index}`, path: `src/${index}.ts`, optional: undefined })),
      omitted: undefined,
      arrayWithUndefined: [undefined, 1],
    };
    await writeJsonAtomic(path, value);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.records).toHaveLength(10_000);
    expect(parsed.records[0]).toEqual({ id: "ev:0", path: "src/0.ts" });
    expect(parsed.arrayWithUndefined).toEqual([null, 1]);
    expect(parsed.omitted).toBeUndefined();
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("cleans up a partial temporary file when serialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "repomap-json-error-"));
    const path = join(root, "broken.json");
    await expect(writeJsonAtomic(path, { valid: [1, 2], unsupported: 1n })).rejects.toThrow("Unsupported JSON value: bigint");
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
