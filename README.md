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
- `architecture.module-graph.json`: TypeScript/JavaScript source-module graph (nodes, edges, cycles, external packages, unresolved imports, tsconfig/workspace resolution rules, independent import declarations and AST evidence records).
- `architecture.go-module-graph.json`: Go **package** graph (go.mod/go.work/replace resolution, explicit GOOS/GOARCH/build-tag file selection, standard-library/external/unresolved sets, cycles, independent import declarations and Tree-sitter AST evidence records).
- `architecture.route-graph.json`: independent route declarations, resolved local/package/computed handlers, bounded direct handler calls, route coverage and parser evidence for Next.js, Vite React Router and Go HTTP routers.
- `architecture.async-graph.json`: Queue/Worker, channel send/receive, Pub/Sub and ticker operations with independent declarations, directions and evidence.
- `architecture.evidence.json`: lossless evidence index with roles, parser/regex source and stable IDs. Regex runtime evidence and AST import evidence share one index.
- `architecture.ir.json`: versioned IR v2 envelope; nodes, edges and operations reference `evidenceIds`/`declarationIds`.
- `architecture.projection.json`: reconciliation manifest for rendered vs. remaining evidence.
- `architecture.json`: Archify input when coverage is publishable. Viewer repository links are omitted unless local-Git evidence is explicitly available; facts retain source evidence.
- `architecture.html`: self-contained Archify artifact when rendering is enabled and accepted.
- `repomap.receipt.json`: status, per-view delivery, declared scope, capabilities, coverage, source/archive metrics, Archify receipts, and visual-review state.

`architecture.facts.json` stays a strict v1 compatibility projection. The lossless reconciliation set is **IR v2 + Evidence Index + Projection Manifest**; facts v1 and HTML are allowed to be lossy. Census, evidence, IR, declarations, analysis and receipt JSON are written with a backpressured streaming writer and atomic replacement; semantic evidence is never capped to make coverage pass.

Coverage failures, raw-budget failures and renderer failures leave diagnostic JSON behind. **A passing Runtime Overview gate is not a complete architecture**: the default receipt keeps `fullArchitecture: false`. A full request (`--view full`) sets `fullArchitecture: true` only when system/runtime/module/protocol views, independent mutations and projection reconciliation all pass; this is per-input semantic completeness, not generator release qualification or human Gold approval. A visually valid diagram, or a view that passes its own checks, cannot change that. See [View, scope and delivery contract](docs/view-terminology.md).

## Views and declared scope

The default view is `runtime-overview`; other views can also be delivered when explicitly requested and their gates pass. `--view` is repeatable (`system|runtime|module|flows|full`); requesting `full` automatically requires every contributing view, and any requested-but-failed view makes the command exit non-zero. `--include`/`--exclude` apply user scope to census, independent declarations and semantic facts, and are recorded in the receipt — a detector capability gap is never disguised as a user exclusion. `--require-external-hosts` enables the strict host gate: only static host targets pass; configured/dynamic/protocol/unknown targets fail, while the default mode still allows explicitly disclosed dynamic targets. `--no-render` writes JSON, coverage and receipt only, without Archify or Chromium.

The receipt records `declaredScope`, `capabilities`, `delivery.views[*]` (with `blockingReasons` and `omissionCount`), `project` (snapshot ID, parser statuses, units, unresolved imports, blocked views), `moduleGraph` (snapshot ID, statistics, blocked views), `mutation`, `declarationCoverage` and `evidenceProjection`. Unknown frameworks, unsupported protocols, unresolved submodules and raw-budget exhaustion are explicit capability gaps or blocking omissions.

Project preparation is parser-optional for the default view. The TypeScript adapter builds **one project-wide** Compiler API `Program` over immutable raw text (imports, re-exports, symbols, structural entrypoints, syntax diagnostics). The Go adapter builds **one project-wide** Tree-sitter Go grammar parse over immutable raw text (package clauses, import specs, function/method/type declarations, build-tag/file-selection, syntax errors), with `go.mod`/`go.work`/`replace` resolution read from the snapshot. Parser unavailability produces `parser-unavailable` omissions that block only `module-architecture` / `protocol-flows` / `full-declared-scope`; it never blocks or upgrades `runtime-overview`. Nothing is marked `parsed` without a parser.

`architecture.module-graph.json` resolves extensionless relatives, directory roots/barrels, `tsconfig` `paths`/`baseUrl`, project references and workspace package names **inside the snapshot only** — the host's `node_modules` is never consulted. Each source file is one module node; cycles are preserved, external packages and unresolved imports are separate sets, and every edge references a stable AST evidence ID in `architecture.evidence.json`. An independent line-scan declaration denominator lets a mutation test prove that disabling the AST extractor blocks the module view instead of silently backfilling edges with regex. This is graph data, **not** a published `module-architecture` view: that view gate, RouteGraph and protocol operations are still unimplemented.

## Supported analysis

The static detectors cover common Next.js, Vite/React, Go, PHP, and miniprogram request flows, along with MySQL, PostgreSQL, SQLite, object storage, scheduled workers, internal HTTP calls, and external services. Generic external candidates additionally cover dynamic endpoints, GraphQL operations, and Go `http.Get` / `http.Post` / `NewRequest` + `client.Do` flows without requiring a provider-specific detector. Known and unknown providers use one candidate path: HTTP/SDK operations, object upload/download, OAuth, inbound webhook callbacks and local process integrations retain operation kind and direction; there is no reserved-identity suppression or hardcoded external-provider bypass. Static hosts, environment-derived identities, protocol-module identities, and unresolved `unknown` candidates are distinguished explicitly; unresolved candidates block publication. Generated third-party bundles under `static/public/assets` are excluded from source inventory. See [Generic external protocols and Harness follow-up](docs/generic-external-protocols.md).

The reader indexes raw entries first and loads selected file contents on demand through a bounded 64-file LRU cache. Dependency, vendor, generated and other excluded directories are still enumerated for census metadata without reading their file contents; only VCS metadata (`.git`) is outside the source-tree inventory. Duplicate raw paths fail reconciliation. GitHub extraction directories remain alive until analysis finishes and are cleaned in both success and failure paths. Inventory limits are resource-safety boundaries, not an AI context budget: defaults are 100,000 directories, 100,000 selected source files, 50 MB per selected file, and 500 MB of selected source content; raw-entry and remote-archive limits are recorded independently. Repositories beyond explicit safety limits still fail rather than returning partial facts.

## Agent Skill

The repository root includes `SKILL.md`. It teaches an Agent to invoke the CLI, inspect semantic coverage before presentation, preserve fixed-revision evidence, and report the receipt and cost honestly. The Skill does not introduce a hosted integration.

## Development

通用完整架构的目标、独立覆盖模型、分阶段 PR 和验收标准见 [docs/full-architecture-plan.md](docs/full-architecture-plan.md)。已完成 M0 / M1 契约切片（视图、CLI/receipt、IR envelope、raw census、独立声明、证据索引、lockfile 负例），以及 M2 的三个可回滚切片：`project-preparation`（不可变 raw snapshot、`LanguageAdapter` 契约、TypeScript Program、显式 build context、parser 门禁、生产依赖与 production-install smoke test）、`ts-module-graph`（全快照 Program、tsconfig/workspace 解析、模块图、循环、AST 证据并账、独立分母 mutation test）和 `go-module-graph`（固定 `web-tree-sitter` + `tree-sitter-go` WASM、Go package 图、build-tag/GOOS-GOARCH 文件选择、go.mod/go.work/replace 解析、标准库/external/unresolved 集合、循环、独立 import 分母与 AST 证据、parser-unavailable 降级；取舍见 [ADR](docs/adr-go-parser.md)）。完整视图门禁、异步数据流、完整身份解析、黄金人工评估和多视图投影尚未实现，详见 [交付契约与已知边界](docs/view-terminology.md) 和 [版本化黄金骨架](docs/gold-manifest.v1.json)。历史接手记录见 [docs/HANDOFF.md](docs/HANDOFF.md)。M3 新增 RouteGraph（Next re-export/alias、Vite React Router、Go net/http/mux/chi 与大写 router 方法、middleware/factory、动态路径和多 method）和统一 External 候选（无专用 provider 旁路）；M4 新增 SQL read/write/transaction/migration operations、Target/Config identity resolution（含 Go 跨文件默认值和严格 static-host gate）、Queue/Channel/Pub/Sub/Schedule async operations。WriteFreely 固定版本为 128/128 routes resolved，Authelia 为 101/101，Commerce 为 1/1；Authelia async 为 73/73 resolved，WriteFreely 为 5/5，Commerce 无运行时 async declaration。Authelia 三次 cached `--no-render` 的本地 M1 数值基线见 [docs/performance-baseline.v1.json](docs/performance-baseline.v1.json)；固定 CI 与视觉发布资格仍需独立验证。

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
