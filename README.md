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
- `architecture.analysis.json`: independent signal inventory, semantic coverage, declarations, mutation result, omissions and source receipt.
- `architecture.source-census.json`: one disposition per raw repository/archive entry, with roles, package ownership and exclusion counts.
- `architecture.declarations.json`: independent declaration inventory and capability/protocol gaps.
- `architecture.project.json`: content-addressed immutable raw snapshot ID, project units, explicit build context, parser versions/capabilities, import refs, structural entrypoints, syntax diagnostics and per-view parser gates.
- `architecture.evidence.json`: lossless evidence index with roles, parser/regex source and stable IDs.
- `architecture.ir.json`: versioned IR v2 envelope; nodes, edges and operations reference `evidenceIds`/`declarationIds`.
- `architecture.projection.json`: reconciliation manifest for rendered vs. remaining evidence.
- `architecture.json`: Archify input when coverage is publishable. Viewer repository links are omitted unless local-Git evidence is explicitly available; facts retain source evidence.
- `architecture.html`: self-contained Archify artifact when rendering is enabled and accepted.
- `repomap.receipt.json`: status, per-view delivery, declared scope, capabilities, coverage, source/archive metrics, Archify receipts, and visual-review state.

`architecture.facts.json` stays a strict v1 compatibility projection. The lossless reconciliation set is **IR v2 + Evidence Index + Projection Manifest**; facts v1 and HTML are allowed to be lossy.

Coverage failures, raw-budget failures and renderer failures leave diagnostic JSON behind. **A passing Runtime Overview gate is not a complete architecture**: `fullArchitecture` is always `false` until the `full-declared-scope` gate exists and passes. A visually valid diagram, or a view that passes its own checks, cannot change that. See [View, scope and delivery contract](docs/view-terminology.md).

## Views and declared scope

The default and only publishable view is `runtime-overview`. `--view` is repeatable (`system|runtime|module|flows|full`); requesting `full` automatically requires every contributing view, and any requested-but-failed view makes the command exit non-zero. `--include`/`--exclude` record user scope only — a detector capability gap is never disguised as a user exclusion. `--require-external-hosts` enables the strict host gate. `--no-render` writes JSON, coverage and receipt only, without Archify or Chromium.

The receipt records `declaredScope`, `capabilities`, `delivery.views[*]` (with `blockingReasons` and `omissionCount`), `project` (snapshot ID, parser statuses, units, unresolved imports, blocked views), `mutation`, `declarationCoverage` and `evidenceProjection`. Unknown frameworks, unsupported protocols, unresolved submodules and raw-budget exhaustion are explicit capability gaps or blocking omissions.

Project preparation is parser-optional for the default view: the TypeScript adapter is a real project-level Compiler API `Program` over immutable raw text (imports, re-exports, symbols, structural entrypoints, syntax diagnostics), while the Go adapter is explicitly declared unavailable. Parser unavailability produces `parser-unavailable` omissions that block only `module-architecture` / `protocol-flows` / `full-declared-scope`; it never blocks or upgrades `runtime-overview`. Nothing is marked `parsed` without a parser.

## Supported analysis

The static detectors cover common Next.js, Vite/React, Go, PHP, and miniprogram request flows, along with MySQL, PostgreSQL, SQLite, object storage, scheduled workers, internal HTTP calls, and external services. Generic external candidates additionally cover dynamic endpoints, GraphQL operations, and Go `http.Get` / `http.Post` / `NewRequest` + `client.Do` flows without requiring a provider-specific detector. Static hosts, environment-derived identities, protocol-module identities, and unresolved `unknown` candidates are distinguished explicitly; unresolved candidates block publication. Generated third-party bundles under `static/public/assets` are excluded from source inventory. See [Generic external protocols and Harness follow-up](docs/generic-external-protocols.md).

The reader indexes source paths first and loads file contents on demand through a bounded 64-file LRU cache. GitHub extraction directories remain alive until analysis finishes and are cleaned in both success and failure paths. Inventory limits are resource-safety boundaries, not an AI context budget: defaults are 100,000 directories, 100,000 source files, 50 MB per file, and 500 MB of source content; the remote archive itself is capped at 500 MB. Repositories beyond explicit safety limits still fail rather than returning partial facts.

## Agent Skill

The repository root includes `SKILL.md`. It teaches an Agent to invoke the CLI, inspect semantic coverage before presentation, preserve fixed-revision evidence, and report the receipt and cost honestly. The Skill does not introduce a hosted integration.

## Development

通用完整架构的目标、独立覆盖模型、分阶段 PR 和验收标准见 [docs/full-architecture-plan.md](docs/full-architecture-plan.md)。已完成 M0 / M1 契约切片（视图、CLI/receipt、IR envelope、raw census、独立声明、证据索引、lockfile 负例），以及 M2 的第一个可回滚切片 `project-preparation`（不可变 raw snapshot、`LanguageAdapter` 契约、TypeScript Program、显式 build context、parser 门禁、生产依赖与 production-install smoke test）。模块图、路由图、协议 operation、身份解析、黄金评估和多视图投影尚未实现，详见 [交付契约与已知边界](docs/view-terminology.md) 和 [版本化黄金骨架](docs/gold-manifest.v1.json)。历史接手记录见 [docs/HANDOFF.md](docs/HANDOFF.md)。

```bash
npm run typecheck
npm test
npm run build
npm run archify:prepare
npm run pack:dry-run
npm run smoke:production   # packs + installs only production deps + runs the packed CLI
```

`typescript` 是 production dependency：打包后的 CLI 直接依赖 Compiler API，不能用仅存在于 devDependencies 的解析器发布。

Archify is pinned to v3.2.0 under MIT. Its ZIP and expected SHA-256 live in `vendor/archify/`; runtime preparation verifies the archive before extraction. RepoMap itself is MIT licensed.
