import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as tar from "tar";
import { githubHeaders, resolveGitHubRevision, type GitHubRepositoryRef } from "./repository.js";
import { isSupportedRepositoryPath, loadLocalRepositorySources, type RepositorySourceBudgets } from "../source/local.js";

export interface GitHubSourceOptions {
  fetcher?: typeof fetch;
  token?: string;
  cacheDir?: string;
  useCache?: boolean;
  maxArchiveBytes?: number;
  budgets?: Partial<RepositorySourceBudgets>;
}

async function downloadArchive(url: string, token: string | undefined, fetcher: typeof fetch, maximum: number) {
  const response = await fetcher(url, { headers: githubHeaders(token), redirect: "follow" });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`GitHub archive ${response.status}: ${body}`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maximum) throw new Error(`GitHub archive exceeds ${maximum} bytes`);
  if (!response.body) throw new Error("GitHub archive response has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error(`GitHub archive exceeds ${maximum} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

async function cachedArchive(path: string, maximum: number) {
  const info = await stat(path);
  if (info.size > maximum) throw new Error(`Cached archive exceeds ${maximum} bytes`);
  return readFile(path);
}

export async function loadGitHubRepositorySources(repository: GitHubRepositoryRef, options: GitHubSourceOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const resolved = await resolveGitHubRevision(repository, { fetcher, token });
  const revision = resolved.revision;
  const maximum = options.maxArchiveBytes ?? 50_000_000;
  const cacheDir = options.cacheDir ?? process.env.REPOMAP_CACHE_DIR ?? join(homedir(), ".repomap", "cache");
  const cachePath = join(cacheDir, repository.owner, repository.repo, `${revision}.tar.gz`);
  let archive: Buffer;
  let cacheHit = false;
  let httpRequests = resolved.apiRequests;
  if (options.useCache !== false) {
    try {
      archive = await cachedArchive(cachePath, maximum);
      cacheHit = true;
    } catch (error) {
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ENOENT") throw error;
      archive = await downloadArchive(`https://codeload.github.com/${repository.owner}/${repository.repo}/tar.gz/${revision}`, token, fetcher, maximum);
      httpRequests += 1;
      await mkdir(dirname(cachePath), { recursive: true });
      const temporaryCache = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporaryCache, archive, { mode: 0o600 });
      await rename(temporaryCache, cachePath);
    }
  } else {
    archive = await downloadArchive(`https://codeload.github.com/${repository.owner}/${repository.repo}/tar.gz/${revision}`, token, fetcher, maximum);
    httpRequests += 1;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "repomap-archive-"));
  try {
    const archivePath = join(temporaryRoot, "repository.tar.gz");
    const extractRoot = join(temporaryRoot, "source");
    await mkdir(extractRoot);
    await writeFile(archivePath, archive, { mode: 0o600 });
    let selectedFiles = 0;
    let selectedBytes = 0;
    const budgets = options.budgets ?? {};
    await tar.x({
      file: archivePath,
      cwd: extractRoot,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        if (!("type" in entry) || entry.type !== "File") return false;
        const relative = path.split("/").slice(1).join("/");
        if (!isSupportedRepositoryPath(relative)) return false;
        selectedFiles += 1;
        if (budgets.maxFiles !== undefined && selectedFiles > budgets.maxFiles) throw new Error("Repository source file budget exhausted");
        selectedBytes += entry.size;
        if (budgets.maxFileBytes !== undefined && entry.size > budgets.maxFileBytes) throw new Error(`Repository source file exceeds max bytes: ${relative}`);
        if (budgets.maxTotalBytes !== undefined && selectedBytes > budgets.maxTotalBytes) throw new Error("Repository source byte budget exhausted");
        return true;
      },
    });
    const loaded = await loadLocalRepositorySources(extractRoot, budgets);
    return {
      ...loaded,
      repository: { owner: repository.owner, repo: repository.repo, revision },
      archive: { bytes: archive.byteLength, sha256: createHash("sha256").update(archive).digest("hex"), cacheHit, httpRequests },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
