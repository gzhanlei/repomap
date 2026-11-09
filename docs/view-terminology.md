# RepoMap 视图、声明范围与交付契约（M0 / M1）

本文对应 `docs/full-architecture-plan.md` 的 M0、M1 契约，说明本轮实现到哪一步、以及**哪些结论还不能得出**。

## 1. 视图等级

| view | 本轮状态 | 说明 |
| --- | --- | --- |
| `system-context` | 未实现门禁 | 请求时返回 `failed` |
| `runtime-overview` | 已实现、唯一可发布视图 | 沿用现有入口/runtime/store/external 门禁，新增 raw census 预算门禁 |
| `module-architecture` | 未实现门禁 | 没有 AST adapter，capability gap 明确记录 |
| `protocol-flows` | 未实现门禁 | operation union 已在 IR v2 定义，但还没有 operation extractor |
| `full-declared-scope` | 未实现门禁 | 不能发布 |

`architecture.html` 仍是默认 Runtime Overview。`repomap.receipt.json` 中的 `fullArchitecture` 恒为 `false`，因为 `full-declared-scope` 的门禁尚未实现。视觉检查通过不会改变视图等级。

**覆盖通过 ≠ 架构完整。** 当前 `coverage.publishable` 只说明 Runtime Overview 的既有信号被覆盖；它不证明模块、路由、异步、身份或协议细节完整。

## 2. CLI / receipt 语义

```bash
repomap analyze <source> --view runtime --view full \
  --include 'src/**' --exclude 'docs/**' \
  --require-external-hosts --no-render
```

- `--view` 可重复；`full` 自动要求四个基础视图。任何被请求但失败的视图都会让命令退出非零，较低视图自己的 `accepted` 状态不会伪造成总成功。
- `--include` / `--exclude` 只表示用户声明的范围；用户排除记录为 `out-of-scope`，绝不会伪装成 detector 能力。
- `--require-external-hosts` 打开额外严格门禁开关，目前只写入声明范围，不改变默认 full 判定。
- `--no-render` 只写 JSON / coverage / receipt，不准备 Archify、不调用 Chromium、不写 HTML。
- Go 构建上下文固定写入 `declaredScope.buildContext`（默认 `linux/amd64`、空 build tags），不继承宿主机隐式值。

每个视图在 `delivery.views` 中独立记录 `accepted | facts-ready | failed | not-requested`、`blockingReasons` 和 `omissionCount`。

## 3. 原始条目 census

`architecture.source-census.json` 直接来自本地文件树或 archive entry stream，**不是**从过滤后的 sources 反推。每个原始条目恰好一个 disposition：

- `status`：`inventoried`（symlink / gitlink）、`selected`（进入行扫描）、`excluded`、`unsupported`、`parse-error`、`not-required`；
- 没有 AST adapter 接入前，绝不把文件标成 `parsed`；`parser` 如实写 `regex-line-scan@1` 或 `none`；
- `role` 区分 source / test / fixture / generated / vendored / schema / migration / manifest / lockfile / config / documentation / binary / unknown；
- `packageId` 由最近的 manifest 目录决定，无法归属时落到 `package:root` 并记录原因；
- `exclusions` 记录规则与数量，`totals.rawEntries` 与 `files.length` 必须对账；
- raw entry / raw bytes 预算耗尽时，所有视图失败、不写 HTML，只保留诊断。

## 4. 独立声明、证据与 IR

- `architecture.declarations.json`：独立 DeclarationInventory，用原始条目结构、manifest 解析和独立的 protocol-capability 词表发现声明，不调用生产 detector。`mutationCheck` 证明禁用全部 semantic extractor 后分母不变且 coverage 报告 missing。
- `architecture.evidence.json`：以 `path + startLine + endLine + extractor + role` 去重的稳定证据索引，区分 `declaration / runtime-call / configuration / schema / migration / inferred-default` 与 `parser / regex` 来源。
- `architecture.ir.json`：版本化 IR v2 envelope，节点/边/operation 保存 `evidenceIds` 和 `declarationIds`。**facts v1 保持 strict schema，不加入 evidenceIds**；无损对账集合是 IR + Evidence Index + Projection Manifest。
- `architecture.projection.json`：记录每个 owner 的代表性证据、剩余证据 ID、选择原因和总数，不做隐藏截断。
- per-view omission impact 骨架：`unsupported-framework`、`unsupported-protocol`、`unresolved-submodule`、`budget-exceeded` 等带 `affectedViews` 与 `blocking`。

## 5. 已知边界（不要越界宣称）

- 没有 AST adapter、ModuleGraph、RouteGraph、protocol operation extractor、身份解析和黄金评估；
- submodule 目前只记录 `unresolved-submodule`，不会作为独立 fixed-SHA 输入获取；
- evidence / census 尚未流式分片写出；
- `docs/gold-manifest.v1.json` 只是版本化骨架，未经过人工审核，不能当作真值；
- 未建立 Authelia 数值性能基线，也未做 fixed-SHA 公共仓库评估与视觉复核。

上述缺口全部写入 `declaredScope.capabilityGaps` 与 `delivery.views[*].blockingReasons`，因此本轮任何输出都只能称为 Runtime Overview，不能称为完整架构。
