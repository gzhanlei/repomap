---
name: repomap
description: Generate evidence-backed architecture facts, semantic coverage diagnostics, and optional Archify HTML from a GitHub repository or local source tree using the RepoMap CLI. Use for repository-to-architecture requests; not for ad hoc diagrams unrelated to source code.
---

# RepoMap

Use the local RepoMap CLI. Do not create a web service, tenant model, database, or Radar integration for this task.

## Workflow

1. Identify the repository, fixed 40-character revision when available, output directory, and whether the user wants HTML or facts only. If a GitHub revision is omitted, the CLI resolves the default branch HEAD once and records the resolved SHA.
2. Prefer a full-SHA remote analysis so the local archive cache can eliminate network requests. Use `--no-render` when the user only needs analysis or wants to avoid rendering cost.
3. Run `repomap analyze <source> [options]`. In a source checkout of RepoMap, use `npm run cli -- analyze <source> [options]`. Read `repomap analyze --help` for current options instead of inventing flags.
4. Read `repomap.receipt.json`, `architecture.analysis.json`, `architecture.project.json`, `architecture.module-graph.json` and `architecture.projection.json` before presenting a diagram. Check `view`, `delivery.views[*]`, `declaredScope`, `capabilities`, `project`/`parsers`, `moduleGraph`, both `gates.blockedViews`, `declarationCoverage`, `mutation`, `rawBudgetExceeded` and omissions. Coverage or per-view delivery failure is a failed result, not a partially successful architecture.
5. Return the output directory, status, declared view, per-view statuses, source/archive cost, capability gaps, semantic omissions, artifact path when accepted, and visual-review state. `visualReview: pending` still requires screenshot inspection; do not claim visual approval without looking at the captures. `fullArchitecture: false` is expected on every run: only `runtime-overview` is publishable, and coverage of that view is not completeness.

## Constraints

- Keep analysis fixed to the recorded revision and preserve source evidence. Never substitute repository-name templates for missing facts.
- Never present a Runtime Overview as a complete architecture, and never upgrade a view because rendering or a visual check passed. A requested `full` view currently fails with a non-zero exit code; report that honestly.
- Read `architecture.facts.json` for v1 compatibility only. Lossless reconciliation uses `architecture.ir.json` + `architecture.evidence.json` + `architecture.projection.json`; facts v1 never gains IR-only fields.
- Treat `architecture.source-census.json` as the raw-entry authority. A lockfile or manifest dependency name is not runtime evidence, and a `selected` entry is not an AST-parsed file.
- Treat `architecture.project.json` as the parser-capability authority: raw `snapshotId` is content-addressed, `parsers[*].status` is honest (`ast-go` and `ast-typescript` are loaded from the snapshot; `parser-unavailable` is reported only when the grammar runtime fails to initialize), and `parser-unavailable` omissions block only parser-dependent views. Never let a missing parser downgrade or upgrade `runtime-overview`.
- `architecture.module-graph.json` is graph data, not a published `module-architecture` view. `resolution` tells you whether a specifier resolved inside the snapshot (`relative` / `alias` / `workspace-package` / `project-reference`) or was honestly declared `external` / `unresolved`. Cycles are intentional; every `edge.evidenceIds` must exist in `architecture.evidence.json`. A missing parser, unresolved relative import, syntax diagnostic or `importDeclarations.missing` entry blocks the module view only.
- `architecture.go-module-graph.json` is graph data too, not a published `module-architecture` view. It works at **package** granularity: `go.mod`/`go.work`/`replace` resolve module and package IDs, explicit `GOOS`/`GOARCH`/`build-tag` constraints select which Go files enter the parse, and each edge resolves to `internal` / `internal-cross-module` / `replace` / `standard-library` / `external` / `unresolved`. Standard-library and external packages are separate sets; `buildTagExcludedFiles` are reported but never silently dropped. Every `edge.evidenceIds` must exist in `architecture.evidence.json`.
- Do not enlarge budgets merely to hide omissions. A truncated or over-budget inventory is not a complete repository analysis.
- Use `GITHUB_TOKEN` only through the environment. Never put tokens in command arguments, logs, receipts, or generated HTML.
- RepoMap performs deterministic static analysis with `aiRequests: 0`. Do not add an LLM call to fill unsupported architecture facts.
- Use the pinned Archify v3.2.0 MIT runtime. Do not switch to an unverified release or disable browser sandboxing for convenience.
