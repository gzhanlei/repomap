import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { isArchitectureSourcePath, type ArchitectureRepositorySourceReceipt, type ArchitectureSource } from "../architecture/source.js";
import { execCommand, type CommandRunner } from "../process.js";

export interface RepositorySourceBudgets {
  maxFiles: number;
  maxDirectories: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const defaultRepositorySourceBudgets: RepositorySourceBudgets = {
  maxFiles: 1000,
  maxDirectories: 1000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
};

const excludedDirectories = new Set([".git", "node_modules", "vendor", "third_party", "dist", "build", "out", "coverage"]);

export function isSupportedRepositoryPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  return isArchitectureSourcePath(normalized);
}

export function numberedSource(path: string, content: string): ArchitectureSource {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { path, content: lines.map((line, index) => `${index + 1}: ${line}`).join("\n") };
}

async function assertDirectory(root: string) {
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`Repository path is not a directory: ${basename(root)}`);
}

export async function verifyLocalGitRevision(repositoryRoot: string, revision: string, runner: CommandRunner = execCommand) {
  let head: string;
  try {
    const result = await runner("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { shell: false, timeout: 30_000 });
    head = result.stdout.trim();
  } catch {
    throw new Error("Local source must be a Git work tree with a fixed revision");
  }
  if (head.toLowerCase() !== revision.toLowerCase()) throw new Error(`Local Git HEAD does not match --revision: ${head}`);
  const status = await runner("git", ["-C", repositoryRoot, "status", "--porcelain"], { shell: false, timeout: 30_000 });
  if (status.stdout.trim()) throw new Error("Local Git work tree is dirty; use a clean fixed revision or a GitHub archive");
}

export async function loadLocalRepositorySources(repositoryRoot: string, overrides: Partial<RepositorySourceBudgets> = {}): Promise<{ sources: ArchitectureSource[]; receipt: ArchitectureRepositorySourceReceipt }> {
  const budgets = { ...defaultRepositorySourceBudgets, ...overrides };
  const root = resolve(repositoryRoot);
  await assertDirectory(root);
  const sources: ArchitectureSource[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let directories = 0;
  let bytes = 0;

  async function visit(directory: string) {
    if (directories >= budgets.maxDirectories) throw new Error("Repository directory budget exhausted");
    directories += 1;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Repository symbolic links are not supported: ${entry.name}`);
      const absolute = resolve(directory, entry.name);
      if (!absolute.startsWith(`${root}${sep}`)) throw new Error("Repository path escapes the source root");
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = absolute.slice(root.length + 1).split(sep).join("/");
      if (!isSupportedRepositoryPath(relative)) continue;
      if (sources.length >= budgets.maxFiles) throw new Error(`Repository source file budget exhausted: ${relative}`);
      const info = await stat(absolute);
      if (info.size > budgets.maxFileBytes) throw new Error(`Repository source file exceeds max bytes: ${relative}`);
      if (bytes + info.size > budgets.maxTotalBytes) throw new Error(`Repository source byte budget exhausted: ${relative}`);
      const buffer = await readFile(absolute);
      const content = decoder.decode(buffer);
      sources.push(numberedSource(relative, content));
      bytes += info.size;
    }
  }

  await visit(root);
  const receipt: ArchitectureRepositorySourceReceipt = { scope: "repository", directories, files: sources.length, bytes };
  return { sources, receipt };
}
