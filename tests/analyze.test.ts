import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSource, analyzeSources } from "../src/core/analyze.js";
import { loadLocalRepositorySources } from "../src/core/source/local.js";
import { nextFixture, revision } from "./helpers.js";

async function fixtureInput() {
  const root = await nextFixture();
  const loaded = await loadLocalRepositorySources(root);
  const outDir = await mkdtemp(join(tmpdir(), "repomap-output-"));
  return {
    identity: { kind: "local" as const, owner: "local", repo: "demo", revision },
    sources: loaded.sources,
    sourceReceipt: loaded.receipt,
    outDir,
  };
}

describe("repository analysis pipeline", () => {
  it("requires an explicit fixed revision for local directories", async () => {
    const root = await nextFixture();
    await expect(analyzeSource({ source: root, render: false })).rejects.toThrow("Local source requires --revision");
    await expect(analyzeSource({ source: root, revision, render: false })).rejects.toThrow("Git work tree");
  });

  it("writes evidence-backed facts and accepted Archify artifacts with cost receipts", async () => {
    const input = await fixtureInput();
    const deliver = vi.fn(async () => ({ ok: true, command: "deliver" }));
    const check = vi.fn(async () => ({ ok: true, command: "visual-check" }));
    const receipt = await analyzeSources({ ...input, locale: "en", visualCheck: true, deliver, check });
    expect(receipt.status).toBe("accepted");
    expect(receipt).toMatchObject({ aiRequests: 0, visualReview: "pending" });
    expect(deliver).toHaveBeenCalledWith({ type: "architecture", input: join(input.outDir, "architecture.json"), output: join(input.outDir, "architecture.html"), quality: "standard" });
    expect(check).toHaveBeenCalledWith({ artifact: join(input.outDir, "architecture.html") });
    const facts = JSON.parse(await readFile(join(input.outDir, "architecture.facts.json"), "utf8"));
    expect(facts.revision).toBe(revision);
    expect(facts.nodes.length).toBeGreaterThan(0);
    const spec = JSON.parse(await readFile(join(input.outDir, "architecture.json"), "utf8"));
    expect(spec.meta.repository).toBeUndefined();
    expect(spec.meta.locale).toBe("en");
    expect(spec.components.every((component: { sources?: unknown }) => component.sources === undefined)).toBe(true);
  });

  it("supports facts-only analysis without invoking Archify", async () => {
    const input = await fixtureInput();
    const deliver = vi.fn();
    const receipt = await analyzeSources({ ...input, render: false, deliver });
    expect(receipt.status).toBe("facts-ready");
    expect(deliver).not.toHaveBeenCalled();
    expect(existsSync(join(input.outDir, "architecture.html"))).toBe(false);
    expect(existsSync(join(input.outDir, "architecture.facts.json"))).toBe(true);
  });

  it("persists coverage failures instead of rendering a misleading diagram", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "repomap-output-"));
    const deliver = vi.fn();
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources: [{ path: "lib/util.ts", content: "1: export const value = 1;" }],
      sourceReceipt: { scope: "repository", directories: 1, files: 1, bytes: 25 },
      outDir,
      deliver,
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.coverage.publishable).toBe(false);
    expect(receipt.elapsedMs).toEqual(expect.any(Number));
    expect(deliver).not.toHaveBeenCalled();
    expect(existsSync(join(outDir, "architecture.json"))).toBe(false);
    expect(existsSync(join(outDir, "architecture.analysis.json"))).toBe(true);
  });

  it("records renderer failures in the receipt", async () => {
    const input = await fixtureInput();
    const receipt = await analyzeSources({ ...input, deliver: vi.fn(async () => { throw new Error("render failed"); }) });
    expect(receipt).toMatchObject({ status: "failed", error: "render failed" });
    expect(existsSync(join(input.outDir, "repomap.receipt.json"))).toBe(true);
  });
});
