import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "../src/cli.js";
import { revision } from "./helpers.js";

describe("RepoMap CLI arguments", () => {
  it("parses analysis options", () => {
    expect(parseCliArguments(["analyze", "octo/demo", "--revision", revision, "--out", "diagram", "--locale", "zh-CN", "--visual-check", "--no-cache"])).toEqual({ source: "octo/demo", revision, outDir: "diagram", locale: "zh-CN", visualCheck: true, useCache: false });
    expect(parseCliArguments(["analyze", "octo/demo", "--no-render"])).toEqual({ source: "octo/demo", render: false });
    expect(parseCliArguments([])).toEqual({ help: true });
    expect(parseCliArguments(["--version"])).toEqual({ version: true });
  });

  it("rejects missing sources, unknown options and invalid locales", () => {
    expect(() => parseCliArguments(["analyze"])).toThrow("requires a repository source");
    expect(() => parseCliArguments(["analyze", "octo/demo", "--unknown"])).toThrow("Missing value");
    expect(() => parseCliArguments(["analyze", "octo/demo", "--locale", "fr"])).toThrow("--locale");
  });
});
