# RepoMap

RepoMap is a local CLI and Agent Skill that turns a GitHub repository or local source tree into evidence-backed architecture facts, semantic coverage diagnostics, and an optional self-contained Archify HTML diagram.

It has **no accounts, database, tenant model, queue, or web service**. Analysis is deterministic and makes no AI requests.

## Requirements

- Node.js 20+
- `unzip` for the pinned Archify runtime
- Chromium only when using `--visual-check`

## Use

```bash
npm install
npm run build

# GitHub shorthand; resolves the default branch HEAD once
npx repomap analyze owner/repo

# Pin an exact revision and choose an output directory
npx repomap analyze owner/repo@0123456789abcdef0123456789abcdef01234567 --out ./diagram

# A GitHub tree URL is also accepted
npx repomap analyze 'https://github.com/owner/repo/tree/0123456789abcdef0123456789abcdef01234567'

# Analyze a local tree; the revision is explicit so dirty content is not mistaken for a Git SHA
npx repomap analyze /path/to/repository --revision 0123456789abcdef0123456789abcdef01234567

# Facts and diagnostics only, without HTML or Chromium
npx repomap analyze owner/repo --no-render

# Optional Archify delivery and browser checks
npx repomap analyze owner/repo --visual-check
```

For private repositories, set `GITHUB_TOKEN` in the environment. Tokens are never accepted as command arguments or included in output.

## Archive-first cost model

Remote repositories use a single codeload archive at a fixed SHA instead of one API request per source file. Archives are cached under `~/.repomap/cache` by owner, repository, and revision. Repeating a full-SHA analysis can therefore use no network requests. Set `REPOMAP_CACHE_DIR` to relocate the cache or pass `--no-cache` to force a download.

Resolving an omitted revision requires one GitHub API request. The archive download is one additional HTTP request. The receipt reports network requests, archive bytes, cache hits, source counts, elapsed time, and `aiRequests: 0`.

## Outputs

The default directory is `./repomap-output/<repository>-<short-sha>`:

- `architecture.candidates.json`: external candidate identities, protocols, dynamic state, operation details and omission outcomes for coverage checks and optional Harness follow-up.
- `architecture.facts.json`: fixed-revision nodes, relationships, roots, and source evidence.
- `architecture.analysis.json`: independent signal inventory, semantic coverage, and source receipt.
- `architecture.json`: Archify input when coverage is publishable. Viewer repository links are omitted unless local-Git evidence is explicitly available; facts retain source evidence.
- `architecture.html`: self-contained Archify artifact when rendering is enabled and accepted.
- `repomap.receipt.json`: status, outputs, coverage, source/archive metrics, Archify receipts, and visual-review state.

Coverage failures and renderer failures leave diagnostic JSON behind. A visually valid diagram is not treated as proof of semantic completeness. Unsupported critical signals, unreachable runtime units, and evidence-free relationships prevent publication.

## Supported analysis

The initial static detectors cover common Next.js, Go, PHP, and miniprogram request flows, along with MySQL, object storage, scheduled workers, internal HTTP calls, and external services. Generic external candidates additionally cover dynamic endpoints and GraphQL operations without requiring a provider-specific detector. Static hosts, environment-derived identities, and unresolved `unknown` candidates are distinguished explicitly; unresolved candidates block publication. See [Generic external protocols and Harness follow-up](docs/generic-external-protocols.md).

The reader rejects incomplete or over-budget source inventories. Defaults are 1,000 directories, 1,000 source files, 1 MB per file, and 10 MB of source content; the remote archive itself is capped at 50 MB. These are independent of any AI context budget because RepoMap does not use AI.

## Agent Skill

The repository root includes `SKILL.md`. It teaches an Agent to invoke the CLI, inspect semantic coverage before presentation, preserve fixed-revision evidence, and report the receipt and cost honestly. The Skill does not introduce a hosted integration.

## Development

当前为待语义补全的接手快照；遗留工作、验证记录和后续优先级见 [docs/HANDOFF.md](docs/HANDOFF.md)。

```bash
npm run typecheck
npm test
npm run build
npm run archify:prepare
```

Archify is pinned to v3.2.0 under MIT. Its ZIP and expected SHA-256 live in `vendor/archify/`; runtime preparation verifies the archive before extraction. RepoMap itself is MIT licensed.
