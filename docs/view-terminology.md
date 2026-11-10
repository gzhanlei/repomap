# RepoMap 视图、声明范围与交付契约（M0 / M1 / M2 / M3）

本文对应 `docs/full-architecture-plan.md` 的 M0、M1、M2 和 M3 切片，说明当前实现到哪一步、以及**哪些结论还不能得出**。

## 1. 视图等级

| view | 本轮状态 | 说明 |
| --- | --- | --- |
| `system-context` | 未实现门禁 | 请求时返回 `failed` |
| `runtime-overview` | 已实现、唯一可发布视图 | 沿用现有入口/runtime/store/external 门禁，新增 raw census、独立 declaration 和通用 package-script owner 门禁 |
| `module-architecture` | 未实现门禁 | 已有 TypeScript/JavaScript 与 Go 两个 ModuleGraph 产物与各自独立分母，但**视图门禁仍未实现**，请求时依然 `failed` |
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
- `--include` / `--exclude` 同时作用于 raw census disposition、独立声明分母和语义事实，并写入声明范围；用户排除记录为 `out-of-scope`，绝不会伪装成 detector 能力。
- `--require-external-hosts` 启用严格门禁：只有 `target.kind=host` 且 `resolution=static` 的候选才能通过。configured/dynamic host、协议目标和 unknown 均会失败；默认模式仍允许带明确动态披露的候选发布。
- `--no-render` 只写 JSON / coverage / receipt，不准备 Archify、不调用 Chromium、不写 HTML。
- Go 构建上下文固定写入 `declaredScope.buildContext`（默认 `linux/amd64`、空 build tags），不继承宿主机隐式值。

每个视图在 `delivery.views` 中独立记录 `accepted | facts-ready | failed | not-requested`、`blockingReasons` 和 `omissionCount`。

## 3. 原始条目 census

`architecture.source-census.json` 直接来自本地文件树或 archive entry stream，**不是**从过滤后的 sources 反推。每个原始条目恰好一个 disposition：

- `status`：`inventoried`（symlink / gitlink）、`selected`（进入行扫描）、`excluded`、`unsupported`、`parse-error`、`not-required`；
- 绝不把文件标成 `parsed`；census 的 `parser` 只描述该 raw entry 被哪套行扫描器选中（`regex-line-scan@1` 或 `none`），AST 解析状态与 unit 归属另见 `architecture.project.json`；
- `role` 区分 source / test / fixture / generated / vendored / schema / migration / manifest / lockfile / config / documentation / binary / unknown；
- `packageId` 由最近的 manifest 目录决定，无法归属时落到 `package:root` 并记录原因；
- `exclusions` 记录规则、数量和完整路径；dependency/vendor/generated 等目录只枚举元数据、不读取内容，`.git` 元数据不属于源码树；重复 raw path 会使对账失败；
- `totals.rawEntries` 与 `files.length` 必须对账，`totals.selected` 是用户 scope 后实际进入分析的文件数；
- raw entry / raw bytes 预算耗尽时，所有视图失败、不写 HTML，只保留诊断；
- include/exclude 不会只改变 receipt：被排除文件也不会进入 declaration 或 facts。

## 4. 独立声明、证据与 IR

- `architecture.declarations.json`：独立 DeclarationInventory，用原始条目结构、manifest 解析和独立的 protocol-capability 词表发现声明，不调用生产 detector。`mutationCheck` 证明禁用全部 semantic extractor 后分母不变且 coverage 报告 missing。
- `architecture.evidence.json`：以 `path + startLine + endLine + extractor + role` 去重的稳定证据索引，区分 `declaration / runtime-call / configuration / schema / migration / inferred-default` 与 `parser / regex` 来源。
- `architecture.ir.json`：版本化 IR v2 envelope，节点/边/operation 保存 `evidenceIds` 和 `declarationIds`。**facts v1 保持 strict schema，不加入 evidenceIds**；无损对账集合是 IR + Evidence Index + Projection Manifest。
- `architecture.projection.json`：记录每个 owner 的代表性证据、剩余证据 ID、选择原因和总数，不做隐藏截断。
- per-view omission impact 骨架：`unsupported-framework`、`unsupported-protocol`、`unresolved-submodule`、`budget-exceeded` 等带 `affectedViews` 与 `blocking`。

## 5. Project Preparation（M2 首个切片）

`architecture.project.json` 是项目级准备层，不是 facts v1 的一部分：

- **不可变 raw snapshot**：parser 输入是原始 UTF-8 文本，`numbered view` 只用于 evidence 展示与行号映射；`snapshotId` 由 revision + 每个 raw entry 的 `path/size/sha256` 内容寻址，供 census、adapter、helper、cache 共用。loader 的 `rawText` 是惰性访问器，不进入 source 对象的可枚举数据。
- **LanguageAdapter 契约**：`prepareProject(snapshot, context)` → `ProjectUnit`，`parseProject` / `declarations` / `symbols` / `imports` / `entrypoints` / `capabilities` 都以项目为单位。声明发现仍与语义提取分离：结构入口由路径发现，不复用 AST detector。
- **TypeScript adapter**：**一个全快照级** Compiler API `Program` 在内存 compiler host 上运行（不是每 unit 一个，否则跨 workspace import 无法解析），覆盖静态 import / re-export / 动态 import / require、exported symbols、结构化入口候选和语法诊断；相对导入、tsconfig paths/baseUrl、project references、workspace 包名都只在 snapshot 内解析，裸包名诚实记为 `external-package-not-in-snapshot`。多 workspace 中同名 `src/index.ts` 按 `packageId` 分到不同 unit。
- **显式 build context**：`goos` / `goarch` / `buildTags` 固定写入（默认 `linux/amd64/[]`），不读取宿主机 `GOOS`/`GOARCH`；`go.work use` 与 `go.mod replace` 从 snapshot 读取并记录。
- **parser 门禁**：`ast-typescript` 与 `ast-go` 都从 snapshot 真实加载；只有当 grammar runtime（`web-tree-sitter` WASM）初始化失败时才报告 `parser-unavailable`。parser 缺失只产生 `parser-unavailable` omission，影响 `module-architecture` / `protocol-flows` / `full-declared-scope`；`gates.runtimeOverviewUnaffected` 恒为 `true`，绝不影响默认视图。
- **生产依赖**：`typescript` 与 `web-tree-sitter` / `tree-sitter-go` 位于 `dependencies`。`npm run pack:dry-run` 与 `npm run smoke:production` 验证仅安装生产依赖的打包 CLI 仍能运行并输出 `architecture.project.json`。Go parser 取舍见 [ADR](adr-go-parser.md)。

## 6. ModuleGraph（M2 第二个切片）

`architecture.module-graph.json` 是**图数据**，不是 `module-architecture` 视图发布结果：

- 粒度为 `source-module`（一个源文件 = 一个模块节点），不展开函数或语句；节点带 `packageId` / `group` / `ownerBasis`（manifest / 目录约定 / 源码声明）、`kind`（source-module / barrel / entrypoint / declaration-file）与导出符号数、入/出度。
- 边带 `resolution`：`relative`（含扩展名省略、目录根、barrel）、`alias`（tsconfig `paths`）、`workspace-package`（monorepo 包名 + `main`）、`project-reference`（tsconfig `references`）、`external`、`unresolved`。解析规则原文记录在 `resolutionRules`，宿主 `node_modules` 从不参与。
- 循环依赖用迭代 Kosaraju 求强连通分量并**保留**，不为布局删边；external packages 与 unresolved imports 分别显式成集；unresolved 相对导入、语法诊断、独立分母缺失会产生 blocking omission，只影响 `module-architecture` / `full-declared-scope`。
- **单一证据索引**：每条 AST import 生成 `ast:ts-import:*` 的 parser 证据记录，合并进 `architecture.evidence.json`（与 regex 证据共用稳定 ID 算法），边的 `evidenceIds` 必须能在该索引中找到；projection manifest 同步增加 `module-edge` owner 与 `architecture.module-graph.json` 输出项。
- **独立分母与 mutation test**：`importDeclarations` 由独立行扫描声明「哪里存在 import 语法」，不产生任何边。禁用 AST 提取器后分母不变、`missing` 为全部声明、模块视图被阻断——证明覆盖分母不来自被评估的提取器，也不会用正则偷偷补边。

## 7. Go Module Graph（M2 第三个切片）

`architecture.go-module-graph.json` 是**图数据**，不是 `module-architecture` 视图发布结果；粒度为 **package**（一个 `package` 声明的目录 = 一个 package 节点），不展开函数或语句：

- **构建上下文固定写入** `declaredScope.buildContext`（`goos` / `goarch` / `buildTags` 默认 `linux` / `amd64` / `[]`），不读取宿主机 `GOOS`/`GOARCH`；每个 Go 文件按 `//go:build` / `// +build` 约束与 (`goos`,`goarch`) 二元组判断进入解析集，`buildTagExcludedFiles` 显式记录，绝不静默丢弃。
- **go.mod / go.work / replace 解析**：`module` 路径作为 module ID，workspace `go.work use` 与 `go.mod replace` 从 snapshot 读取并把被替换路径重定向到替换目标；多 module 仓库按 module 边界分节点。
- **边带 `resolution`**：`internal`（同 module 内包）、`internal-cross-module`（同仓库跨 module）、`replace`（被 replace 重定向）、`standard-library`（Go 标准库）、`external`（外部 module）、`unresolved`。标准库与外部 module 分别显式成集，宿主 `GOPATH`/网络从不参与。
- **循环依赖**用与 TS 同源的迭代 Kosaraju 求强连通分量并**保留**，不为布局删边；`standardPackages` 与 `externalModules` 分别列出，unresolved import 单独成集。
- **单一证据索引**：每条 AST import spec 生成 `ast:go-import:*` 的 parser 证据记录，合并进 `architecture.evidence.json`；边的 `evidenceIds` 必须能在索引中找到；projection manifest 同步增加 `go-module-edge` owner 与 `architecture.go-module-graph.json` 输出项。
- **独立分母与 mutation test**：`importDeclarations` 由独立行扫描声明「哪里存在 import 语法」（不依赖 AST），禁用 Go AST 提取器后分母不变、`missing` 为全部声明、模块视图被阻断——证明覆盖分母不来自被评估的提取器。
- **降级**：当 `web-tree-sitter` WASM 无法初始化时，`ast-go` 报告 `parser-unavailable`，产物退化为 `buildContext` + `excludedFiles` + `importDeclarations`（独立分母仍在），`gates.runtimeOverviewUnaffected` 恒为 `true`。

## 8. RouteGraph 与统一 External（M3）

`architecture.route-graph.json` 是路由与有限调用图数据，不是 `module-architecture` 或 `protocol-flows` 的发布结果：

- **独立 declarations**：行扫描只声明 route method/path/位置，不能生成 handler edge；禁用 parser 后 declaration 仍保留并阻断 module/flows/full。
- **Next.js**：支持文件路由、HTTP method 函数/变量、命名 re-export 与 alias，handler 关联到真实模块和直接 import call。
- **Vite React Router**：支持有 AST 证据的 path/component，解析到组件模块，不把普通对象属性猜成路由。
- **Go HTTP**：支持 net/http、mux/chi 风格、大小写 HTTP 方法、middleware/factory、computed handler、`Path(...).Handler(...)`、动态路径表达式和多 `Methods`；`csrf.Path` 等非 router 调用被排除。
- **有限调用摘要**：只记录 handler 直接 import/package call，不宣称全函数调用图；每个 route/handler/call 都有 evidenceIds，并合入统一 evidence index。
- **覆盖**：WriteFreely 固定版本 128/128、Authelia 101/101、Commerce 1/1 route declarations resolved；这些是固定 SHA 回归结果，不是人工 Gold 完成声明。
- **统一 External**：专用 external detector 和 reserved identity suppression 已删除；GitHub 等静态 host、COS upload/download、OAuth、Webhook callback、Archify process integration 与未知 provider 都进入同一候选和 operation 路径。

## 9. 已知边界（不要越界宣称）

- 有 RouteGraph 和统一 External operation，但 `module-architecture` / `protocol-flows` **视图门禁**、异步数据流、完整 Target/Config 解析和黄金人工评估仍未实现；
- submodule 目前只记录 `unresolved-submodule`，不会作为独立 fixed-SHA 输入获取；
- evidence / census / IR / receipt 已通过带回压和原子替换的流式 JSON writer 写出；内存中的语义分析对象尚未全流式化，固定 CI 性能门槛仍需复核；
- `docs/gold-manifest.v1.json` 已固定三个仓库的 SHA/archive hash，但仍未经过人工审核，不能当作真值；
- 已建立 Authelia 本地三次数值基线（见 `docs/performance-baseline.v1.json`），固定 CI 与视觉发布资格仍需独立验证。

上述缺口全部写入 `declaredScope.capabilityGaps` 与 `delivery.views[*].blockingReasons`，因此本轮任何输出都只能称为 Runtime Overview，不能称为完整架构。
