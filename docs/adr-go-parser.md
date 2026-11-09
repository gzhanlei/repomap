# ADR: Go parser runtime for the M2 Go module graph

- 状态：Accepted（PR #7 `go-module-graph`）
- 日期：2026-11-09
- 对应计划：`docs/full-architecture-plan.md` §7.3、§7.4、§8.1
- 决策范围：Go 源码的**语法解析层**，不涉及类型检查、SSA、route/handler 或调用图

## 1. 背景与约束

计划 §7.3 要求先做解析方案对比，再固定版本；明确禁止「为了 Node-only 退回不完整正则并宣称完整」。同时要求：

- helper 只读、离线，不执行仓库代码，不自动 `go mod download`；
- helper 与 census/evidence 使用同一份 immutable raw snapshot；
- 构建上下文 GOOS/GOARCH/tags/workspace/replace 显式记录，不继承宿主机隐式值；
- 工具缺失时只能发布既有门禁下的 Runtime Overview，不能发布 Module Architecture；
- 解析 runtime 必须是 production dependency 或有意识地 bundle，并通过 packed CLI 生产安装 smoke test。

## 2. 候选方案

| 维度 | A. Go 标准库 `go/parser` helper | B. 固定 Tree-sitter/WASM grammar | C. 正则行扫描 |
| --- | --- | --- | --- |
| 语法正确性 | 完整 Go 语法（`go/ast`） | 完整语法树（tree-sitter-go grammar），ERROR/MISSING 节点可检测 | 无法正确处理注释、raw string、多行 import、嵌套表达式 |
| 宿主依赖 | 需要 Go 工具链与可写 GOCACHE，或为每个平台预编译二进制 | 仅 npm 生产依赖，WASM 随包分发 | 无 |
| 跨平台 | 需按 GOOS/GOARCH 分发二进制或现场编译 | 同一 WASM，Node ≥ 20 即可 | 是 |
| 离线 | 标准库可离线，但 `go run` 仍可能触发 toolchain 解析 | 完全离线，无网络、无子进程 | 是 |
| 与 immutable snapshot 对接 | JSON stdin/stdout 子进程，内容需序列化 | 直接解析 `snapshot.rawText()` 字符串 | 直接 |
| 同步流水线兼容 | `spawnSync` 可行，但每次编译/启动开销大 | 顶层 await 初始化后完全同步 | 是 |
| 生产安装 | 不能自证；无 Go 工具链时降级 | `npm install --omit=dev` 后即可用 | 是 |
| 语义能力 | `go/types` 可做类型解析（需 loader/依赖） | 仅语法，无类型/SSA/包加载 | 无 |

C 被计划明确排除，不能作为「完整」方案，只保留为**独立 declaration discovery 的分母扫描器**（不产生任何事实边）。

A 的主要问题是把发布能力绑定在宿主机工具链上：计划要求「工具缺失时只能发布 Runtime Overview」，若采用 A，则大多数纯 Node 安装环境永远无法得到 Go 模块图；且 `go run` 每次编译、GOCACHE 可写性、跨平台二进制分发都会让 production smoke test 失去确定性。

## 3. 决策

采用 **B**：固定 `web-tree-sitter@0.27.2` 运行时与 `tree-sitter-go@0.25.0` WASM grammar，两者都是**精确版本**的 production dependency（不使用 `^`），版本写入 `architecture.project.json` 的 `distribution.parserVersions` 与 Go graph 的 `parser` 字段。

实现要点：

- `src/core/architecture/project/go-parser.ts` 在模块顶层 `await Parser.init()` 与 `Language.load()`。ESM 顶层 await 保证任何依赖方求值时 WASM 已就绪，因此 `prepareProjects` / `analyzeArchitectureFacts` 等既有同步契约不变。
- WASM 文件通过 `createRequire(import.meta.url).resolve(...)` 从 npm 包内定位，不访问仓库、不执行仓库代码、不发网络请求。
- 初始化失败被捕获为 `parser-unavailable` capability，而不是在分析时抛异常；Runtime Overview 的既有边界不受影响。
- `tree-sitter-go` grammar 的 ABI 与 `web-tree-sitter@0.27.2` 已实测兼容；`tree-sitter-wasms@0.1.13` 的旧 ABI 实测不兼容，故不采用。

## 4. 能力边界（明确声明为 partial）

Tree-sitter 提供的是**语法树**，不是 Go 的类型系统。本切片只发布：

- `package` 声明、目录级 package 归属；
- `import` 声明（普通/别名/blank/dot，含 raw string 与多行 import block），带 1-based 行号；
- function / method / type / var / const 的导出符号；
- call expression 计数；
- ERROR/MISSING 语法诊断。

**不发布**：receiver 类型解析、跨文件常量求值、接口/动态 dispatch、`go list` 包加载、SSA、route→handler、调用关系图。因此 `ast-go` 与 `module-graph-go` 的 capability 都是 `partial`，而不是 `available`。遇到无法证明的语义只能产生 omission，不能用语法树猜测。

## 5. 构建上下文

`goos` / `goarch` / `buildTags` 来自显式输入（默认 `linux` / `amd64` / `[]`），绝不读取宿主环境变量。文件级 build constraint 的求值范围：

- 文件名后缀 `_GOOS.go`、`_GOARCH.go`、`_GOOS_GOARCH.go`；
- `//go:build` 表达式（`!`、`&&`、`||`、括号、tag）；
- 旧式 `// +build` 行（空格为 OR、逗号为 AND、多行为 AND）；
- 可用 tag 集合为 `{goos, goarch, unix?, gc, cgo?}` 与用户显式 buildTags。

被排除的文件进入 Go graph 的 `excludedFiles`，写明原因；它们不进入 AST 也不进入 facts v1，属于声明范围内有记录的 disposition，不是静默丢弃。

## 6. 降级与发布语义

| 条件 | 行为 |
| --- | --- |
| WASM grammar 未加载 | `ast-go` capability = `unavailable`，Go graph 为空并产生 blocking `parser-unavailable` omission |
| 注入 `createUnavailableAdapter("ast-go", ...)` | 同上，用于 mutation / 可用性测试 |
| 语法诊断 / 内部 import 无法解析 / 独立分母缺边 | blocking `parse-error` / `unresolved-import` / `unsupported-syntax` omission |
| 上述任一发生时 | `module-architecture`、`full-declared-scope` 阻塞；`runtime-overview` 不受影响（`runtimeOverviewUnaffected: true`） |
| stdlib / 外部 module | 明确的 `standard-library` / `external` 边，不算 unresolved |

## 7. 实测与跨平台

在 darwin/arm64、Node 22 上（本机，非 CI 基线）：

- WASM 初始化 + grammar 加载约 **130 ms**（一次性，模块加载时）；
- 连续解析 200 个约 230 字节的 Go 文件约 **21 ms**（≈0.1 ms/文件）。

WASM 与平台无关；`npm pack --dry-run` 与 `smoke:production` 负责证明生产安装后 grammar 可用。该数值只是本次 ADR 的量级说明，不是计划 §12.6 的 release-gating 性能基线，后者仍需在固定 CI runner 上建立。

## 8. 后续

若后续 M3/M4 需要 receiver/类型/SSA 级证明，必须另开 ADR 引入项目级 Go 类型信息，并把 capability 从 `partial` 提升；不能把本切片的语法树结论直接标成语义完整。
