import { z } from "zod";

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
  revision?: string;
}

const revisionSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);
const commitSchema = z.object({ sha: revisionSchema });

function validRevision(value: string | undefined) {
  return value === undefined ? undefined : revisionSchema.parse(value.toLowerCase());
}

function repositoryName(value: string) {
  const name = value.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Invalid GitHub repository name");
  return name;
}

export function parseGitHubRepository(input: string): GitHubRepositoryRef | undefined {
  if (input.startsWith("https://") || input.startsWith("http://")) {
    const url = new URL(input);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 && !(parts.length === 4 && parts[2] === "tree")) throw new Error("GitHub URL must identify a repository or a fixed revision tree");
    return { owner: parts[0], repo: repositoryName(parts[1]), revision: validRevision(parts[3]) };
  }
  const match = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:@([a-fA-F0-9]{40}))?$/);
  if (!match) return undefined;
  return { owner: match[1], repo: repositoryName(match[2]), revision: validRevision(match[3]) };
}

export function githubHeaders(token?: string) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "repomap-cli",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function responseError(response: Response) {
  const body = (await response.text()).slice(0, 500);
  return new Error(`GitHub API ${response.status}: ${body}`);
}

export async function resolveGitHubRevision(repository: GitHubRepositoryRef, options: { fetcher?: typeof fetch; token?: string } = {}) {
  if (repository.revision) return { revision: repository.revision, apiRequests: 0 };
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/HEAD`, { headers: githubHeaders(options.token) });
  if (!response.ok) throw await responseError(response);
  const commit = commitSchema.parse(await response.json());
  return { revision: commit.sha.toLowerCase(), apiRequests: 1 };
}
