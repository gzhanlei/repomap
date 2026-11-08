import { describe, expect, it } from "vitest";
import { archifyRoot, readArchifyRelease, verifyArchifyArchive } from "../src/core/archify-runtime.js";

describe("pinned Archify runtime", () => {
  it("verifies the bundled MIT archive bytes", () => {
    expect(readArchifyRelease()).toMatchObject({ version: "3.2.0", license: "MIT", sha256: "70e210265c59f24dcbdf2a502ff671104b5454e7ee7d3554aecd86bad32384f5" });
    expect(verifyArchifyArchive()).toContain("archify-v3.2.0.zip");
    expect(archifyRoot()).toContain("vendor/archify");
  });
});
