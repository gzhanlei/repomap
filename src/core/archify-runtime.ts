import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { execCommand, type CommandRunner } from "./process.js";

const releaseSchema = z.object({
  version: z.literal("3.2.0"),
  license: z.string(),
  archive: z.literal("archify-v3.2.0.zip"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().url(),
  licenseSource: z.string().url(),
});

export type ArchifyRelease = z.infer<typeof releaseSchema>;

export function archifyRoot() {
  return process.env.ARCHIFY_HOME ? resolve(process.env.ARCHIFY_HOME) : fileURLToPath(new URL("../../vendor/archify", import.meta.url));
}

export function readArchifyRelease(root = archifyRoot()): ArchifyRelease {
  const release = releaseSchema.parse(JSON.parse(readFileSync(join(root, "release.json"), "utf8")));
  if (release.license !== "MIT") throw new Error("Archify must use the MIT-licensed release");
  return release;
}

export function verifyArchifyArchive(root = archifyRoot()) {
  const release = readArchifyRelease(root);
  const archive = join(root, release.archive);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sha256 !== release.sha256) throw new Error("Archify archive SHA-256 mismatch");
  return archive;
}

export async function prepareArchify(root = archifyRoot(), runner: CommandRunner = execCommand) {
  const release = readArchifyRelease(root);
  const runtime = join(root, "runtime");
  const bin = join(runtime, "archify", "bin", "archify.mjs");
  const marker = join(runtime, ".archify-sha256");
  const archive = verifyArchifyArchive(root);
  if (existsSync(bin) && existsSync(marker) && readFileSync(marker, "utf8") === release.sha256) return bin;

  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime);
  await runner("unzip", ["-q", archive, "-d", runtime], { shell: false, timeout: 60_000 });
  if (!existsSync(bin)) throw new Error("Archify runtime is missing bin/archify.mjs");
  writeFileSync(marker, release.sha256, { mode: 0o600 });
  return bin;
}
