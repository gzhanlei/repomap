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
4. Read `repomap.receipt.json` and `architecture.analysis.json` before presenting a diagram. Coverage or delivery failure is a failed result, not a partially successful architecture.
5. Return the output directory, status, source/archive cost, semantic omissions, artifact path when accepted, and visual-review state. `visualReview: pending` still requires screenshot inspection; do not claim visual approval without looking at the captures.

## Constraints

- Keep analysis fixed to the recorded revision and preserve source evidence. Never substitute repository-name templates for missing facts.
- Do not enlarge budgets merely to hide omissions. A truncated or over-budget inventory is not a complete repository analysis.
- Use `GITHUB_TOKEN` only through the environment. Never put tokens in command arguments, logs, receipts, or generated HTML.
- RepoMap performs deterministic static analysis with `aiRequests: 0`. Do not add an LLM call to fill unsupported architecture facts.
- Use the pinned Archify v3.2.0 MIT runtime. Do not switch to an unverified release or disable browser sandboxing for convenience.
