import { readFileSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { isArchitectureSourcePath, type ArchitectureRepositorySourceReceipt, type ArchitectureSource } from "../architecture/source.js";
import { excludedDirectoryRules } from "../architecture/file-roles.js";
import type { RepositoryFileEntry } from "../architecture/census.js";
import { execCommand, type CommandRunner } from "../process.js";

export interface RepositorySourceBudgets {
  maxFiles: number;
  maxDirectories: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  contentCacheFiles?: number;
}

export const defaultRepositorySourceBudgets: RepositorySourceBudgets = {
  maxFiles: 100_000,
  maxDirectories: 100_000,
  maxFileBytes: 50_000_000,
  maxTotalBytes: 500_000_000,
  contentCacheFiles: 64,
};

const excludedDirectories = new Set(excludedDirectoryRules);
const maxInventoryFiles = 200_000;

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

export function createSourceContentCache(capacity = 64) {
  const limit = Math.max(1, Math.floor(capacity));
  const cache = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    /** Raw bytes decoded as UTF-8, without display line numbers. */
    readRaw(absolute: string) {
      return decoder.decode(readFileSync(absolute));
    },
    read(absolute: string) {
      const existing = cache.get(absolute);
      if (existing !== undefined) {
        cache.delete(absolute);
        cache.set(absolute, existing);
        return existing;
      }
      const content = numberedSource(absolute, this.readRaw(absolute)).content;
      if (cache.size >= limit) cache.delete(cache.keys().next().value as string);
      cache.set(absolute, content);
      return content;
    },
    get size() { return cache.size; },
  };
}

export function lazyNumberedSource(path: string, absolute: string, cache: ReturnType<typeof createSourceContentCache>): ArchitectureSource {
  const source: ArchitectureSource = {
    path,
    get content() {
      return cache.read(absolute);
    },
  };
  // A lazy reader, not data. Keep it out of enumeration so source objects stay
  // comparable/serializable across independent loads of the same snapshot.
  Object.defineProperty(source, "rawText", { enumerable: false, value: () => cache.readRaw(absolute) });
  return source;
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

export async function loadLocalRepositorySources(repositoryRoot: string, overrides: Partial<RepositorySourceBudgets> = {}): Promise<{ sources: ArchitectureSource[]; receipt: ArchitectureRepositorySourceReceipt; inventory: RepositoryFileEntry[] }> {
  const budgets = { ...defaultRepositorySourceBudgets, ...overrides };
  const root = resolve(repositoryRoot);
  await assertDirectory(root);
  const sources: ArchitectureSource[] = [];
  const inventory: RepositoryFileEntry[] = [];
  const contentCache = createSourceContentCache(budgets.contentCacheFiles);
  let directories = 0;
  let bytes = 0;

  async function visit(directory: string) {
    if (directories >= budgets.maxDirectories) throw new Error("Repository directory budget exhausted");
    directories += 1;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (!absolute.startsWith(`${root}${sep}`)) throw new Error("Repository path escapes the source root");
      const relative = absolute.slice(root.length + 1).split(sep).join("/");
      // Symlinks and gitlinks are raw entries with their own disposition; they
      // are never followed, never read, and never silently dropped.
      if (entry.isSymbolicLink()) {
        const info = await lstat(absolute);
        inventory.push({ path: relative, size: info.size, entryKind: "symlink", selected: false });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (inventory.length >= maxInventoryFiles) throw new Error(`Repository file inventory budget exhausted: ${relative}`);
      const info = await stat(absolute);
      const record: RepositoryFileEntry = { path: relative, size: info.size, entryKind: "file", selected: false };
      inventory.push(record);
      if (!isSupportedRepositoryPath(relative)) continue;
      if (sources.length >= budgets.maxFiles) throw new Error(`Repository source file budget exhausted: ${relative}`);
      if (info.size > budgets.maxFileBytes) throw new Error(`Repository source file exceeds max bytes: ${relative}`);
      if (bytes + info.size > budgets.maxTotalBytes) throw new Error(`Repository source byte budget exhausted: ${relative}`);
      record.selected = true;
      sources.push(lazyNumberedSource(relative, absolute, contentCache));
      bytes += info.size;
    }
  }

  await visit(root);
  const receipt: ArchitectureRepositorySourceReceipt = { scope: "repository", directories, files: sources.length, bytes };
  return { sources, receipt, inventory: inventory.sort((a, b) => a.path.localeCompare(b.path)) };
}
