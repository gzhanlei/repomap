# RepoMap 通用完整架构生成计划

状态：Proposal v2，已根据独立评审修订，待评审
日期：2026-11-08
基线：`8a920440303cb936783de7547cb23e1fbf3f4322`
适用项目：`gzhanlei/repomap`

## 0. 文档目的

本文定义 RepoMap 从当前的 **Runtime Overview（运行时概览）** 演进为 **通用、分层、证据化、在声明范围内可证明完整的架构生成器** 的实施计划。

本轮只交付计划，不实现新的提取器，也不宣称当前产物已经完整。后续实现必须拆成可独立评审的小 PR，每个 PR 同时提交失败测试、证据、覆盖变化和必要的黄金答案更新。

本文中的“必须”是发布门禁的规范性要求，不是可选建议。

## 1. 当前基线与问题

### 1.1 已具备的能力

- GitHub fixed-SHA archive、缓存和本地源码输入；
- 按需源码读取、64 文件 LRU 内容缓存、临时目录清理；
- 确定性静态分析，默认 `aiRequests: 0`；
- 入口、运行单元、部分数据库和外部服务识别；
- HTTP、GraphQL、SQL、部分 Go 出站请求候选；
- 源码路径与行号证据、candidate、omission 和覆盖门禁；
- Archify 固定版本渲染及浏览器视觉检查。

这些能力应保留，但不能继续把当前覆盖门禁等同于完整架构证明。

### 1.2 三个固定版本暴露的问题

| 仓库 | 源码规模 | 当前 facts | 主要问题 |
| --- | ---: | ---: | --- |
| Authelia | 1,360 个支持源码文件 | 13 节点、25 边 | 单个 Go 节点折叠 264–487 个 `sourcePaths`，内部模块、路由和调用缺失 |
| WriteFreely | 124 个支持源码文件 | 14 节点、13 边 | 93 个源码路径折叠为一个 Go 节点，handler 与业务模块缺失 |
| Commerce | 70 个支持源码文件 | 5 节点、9 边 | UI/API/Shopify 过度聚合，GraphQL 只在候选层保留操作细节 |

额外发现：

- `worker: 0`、`relationship: 0` 只说明现有信号没有识别到对象，不说明对象不存在。
- `blockingOmissions: []` 只覆盖已发现候选，不能发现“检测器和信号规则一起漏掉”的对象。
- WriteFreely 的 `store:postgres` 仅由 `prose/package-lock.json:2540` 触发，说明 lockfile 中的包名被误当成运行时数据库证据。
- Authelia 数据库存储节点携带数千条证据，当前按行重复聚合的模型不适合大型仓库。
- Go runtime 的显示名和 `runtimeUnit` 被缩短，完整路径主要留在 ID/sourcePaths 中；IR 需要把显示标签与稳定身份彻底分离。
- 当前输入在分析前过滤未知扩展名、extensionless 文件、测试、vendor 和二进制，因而无法直接支持“每个原始仓库条目都有处理结果”的完整清单。

### 1.3 根因

1. 检测目标集中于入口、存储和外部服务，没有统一模块与调用模型。
2. 信号清单与 detector 使用相似文本标记，覆盖分母和事实提取存在相关盲区。
3. facts 同时承担语义交换和渲染投影，导致为了可读性而损失细节。
4. 一个全局 `publishable` 没有区分系统概览、模块架构和协议详图。
5. 证据按行直接嵌入节点，既可能重复膨胀，也缺乏证据角色与解析来源区分。
6. 当前硬编码 external rules 和 reserved identity suppression 使部分已知服务绕过统一候选路径，通用性迁移尚未完成。

## 2. 目标、边界与完整性定义

### 2.1 总目标

> 对明确声明的语言、框架版本、协议、目录、构建上下文和视图范围，生成可追溯、可评估、可分层的架构事实；独立清单中的每个必需声明必须被覆盖，任何未覆盖、无法解析或无法确定的对象都必须成为阻塞 omission。

### 2.2 “通用”的定义

- 通过 LanguageAdapter、ProtocolExtractor 和统一 IR 扩展能力；
- 规则基于语法、模块、协议、配置和运行时调用证据；
- 不按仓库名、组织名或厂商名建立专用分支；
- 未注册 SDK 也能通过网络调用进入候选，不因没有专用 detector 而消失；
- 不支持的语言、框架或语法必须报告 capability gap，不能通过缩小分母形成“完整”。

通用不意味着对未知框架作出不可证明的全知承诺。完整声明只适用于**能够被独立枚举、且声明支持的语言/框架/语法范围**；范围发现本身遇到未知能力时必须阻塞 full，而不是自动将其排除。

### 2.3 “完整”的定义与 omissions 的地位

完整不是“图中节点很多”，也不是“所有运行时行为都能静态确定”。完整必须同时满足：

1. 原始仓库每个条目都有处理结果或排除原因；
2. 独立 DeclarationInventory 中每个必需声明都有对应事实；
3. 每条事实边都有证据、方向和稳定端点；
4. 解析失败、未支持语法、动态目标和隐藏截断均进入门禁；
5. 在 generator release qualification 中，黄金语料 critical 节点、边、方向、operation 细节的 recall、precision 和语义证据有效率均为 100%，已知 critical false positive 为 0；
6. 总览和详图来自同一份 IR + projection manifest，能够完整对账。

**Omission 永远不算 covered fact，也不能抵扣 critical recall。**

- 人工审核可以确认 omission 的解释是否准确，但不能把 critical miss 降级为通过。
- critical 声明只要有 omission，`full-declared-scope` 就必须失败。
- 非 critical omission 是否阻塞由其所属视图和声明范围决定，不能由实现者临时选择。
- 用户明确排除的范围可以不计入该次声明范围，但必须显示在 scope/receipt 中，且不得把“工具不支持”伪装成用户排除。

### 2.4 非目标

- 不推断远端 SaaS 或第三方服务的内部架构；
- 不承诺静态解析所有反射、动态插件和运行时特征开关；
- 不生成没有源码证据的“常见架构”；
- 不建立 Web 服务、账号、数据库、租户、队列或 Radar 集成；
- 不用 LLM 补全缺失事实；默认仍为 `aiRequests: 0`；
- 不以放大预算、增加节点数或修改截图作为完整性手段；
- 不让 Archify 承担语义分析或覆盖判定。

## 3. 视图、声明范围与 CLI 交付语义

### 3.1 视图等级

| view | 内容 | 独立发布条件 |
| --- | --- | --- |
| `system-context` | 用户、产品边界、外部系统 | 外部调用均有 target/resolution，未知 egress 阻塞 |
| `runtime-overview` | deployable、入口、runtime、存储、外部依赖 | 原始条目预算、runtime/store/external 声明及必要能力门禁通过 |
| `module-architecture` | package、module、内部 import/call、route-handler | 模块归属、解析覆盖、路由覆盖和内部关系门禁通过 |
| `protocol-flows` | GraphQL operation、queue、Worker、SQL/HTTP 数据流 | 声明协议的 operation/consumer/producer 均有证据或阻塞 omission |
| `full-declared-scope` | 上述所有已声明范围 | 所有声明视图通过，且所有必需声明无遗漏 |

`architecture.html` 继续作为默认 Runtime Overview，保持兼容。只有 `full-declared-scope` 通过时，receipt 才能出现 `fullArchitecture: true`。

### 3.2 声明范围

每次分析必须记录：

- fixed revision、原始归档/文件树身份；
- 包含和用户明确排除的路径；
- 检测到的语言、框架及版本、包管理器和 workspace；
- 可用解析器、版本、发行方式和 capabilities；
- Go 的 GOOS、GOARCH、build tags、workspace/replace 上下文；
- 声明支持的协议与视图；
- 请求视图与为 full 自动要求的视图；
- 因工具缺失或未知框架造成的 capability gap。

框架或协议不能因为“尚未声明支持”就静默从分母消失。依赖、配置或源码显示存在未知框架时，必须记录 `unsupported-framework`；独立 protocol-capability discovery 发现 gRPC、WebSocket、对象存储、云消息等尚未支持的协议时，必须记录 `unsupported-protocol`。两者都阻塞 full，除非用户明确排除其 owning scope 后以较窄 scope 重新运行。通用网络候选不能替代协议 operation 覆盖。

### 3.3 CLI/config 计划

M0 必须先定义兼容的 CLI/config 和 receipt，不允许实现到中期才补交付语义：

- 默认 `--view runtime-overview`，保持现有行为；
- `--view` 可重复，支持 system/runtime/module/flows/full；请求 full 自动要求所需视图；
- `--include <glob>`、`--exclude <glob>` 只表示用户范围，默认值不排除未知框架；
- `--require-external-hosts` 启用额外的 `allExternalHostsResolved` 严格门禁，不作为普通 full 的默认条件；
- Go 构建上下文通过固定 config/flags 声明并写入 receipt，不继承宿主机隐式默认值；
- `--no-render` 只写 JSON/coverage/receipt，不准备 Archify、不调用 Chromium；
- 每个视图有 `accepted | facts-ready | failed | not-requested`；
- 只要任一用户请求视图失败，命令退出非零；较低等级视图可以带自己的 accepted 状态输出，但不能改变失败总状态；
- 原始条目预算或 archive 安全失败时，所有视图均不可发布，不写 HTML，只保留诊断；
- `fullArchitecture` 是**单次输入的语义状态**，只在 full 请求且确定性语义、证据和投影门禁通过时为 true，不代表整个生成器已经通过发布资格评估。

### 3.4 单次语义完整与生成器发布资格分离

必须分别报告两种状态：

- **Per-input semantic full（`fullArchitecture`）**：只由该 fixed-SHA 输入的 raw census、declaration coverage、语义/证据校验和 projection round-trip 决定。任意本地输入都可以按这些确定性规则通过或失败，不要求它先成为公共黄金语料。
- **Generator release qualification**：由独立 corpus、critical precision/recall、性能、production install、跨平台、浏览器和人工视觉审核共同决定，只在独立发布评估报告中记录，不能从单次 CLI 的 `fullArchitecture` 推断。

如果输入绑定了 input-specific Gold Standard，任何 critical mismatch 同时阻塞该输入的 full 和 release 评估。没有 Gold 的本地输入不能声称经过黄金召回/精确率验证，只能声称通过声明范围内的确定性门禁。

`--no-render` 下 render/browser/human-visual 状态为 `not-requested`，不得调用 Archify/Chromium，也不要求这些视觉步骤来决定 per-input semantic full。视觉结果只影响视图交付和 generator release qualification，不能反向修改已经确定的语义事实。

## 4. 目标处理流水线与独立性

```text
Raw Source Snapshot / Raw Entry Census
  ├─ DeclarationInventory（独立声明发现、独立 declarationId）
  └─ Project Preparation / LanguageAdapter
       → AST、symbol、import、entrypoint
       → Package / Module Graph
       → Route / Handler / Call / Data-flow IR
       → ProtocolExtractor
       → TargetResolver
       → Architecture IR + OperationFact + Evidence Index
             ↓
       Independent Coverage Evaluator
       （Raw Census + DeclarationInventory + IR + Gold）
             ↓
       Projection Manifest → Archify / JSON / Receipt
```

关键约束：

- DeclarationInventory 与 Semantic Extraction 是不同组件、不同分类逻辑和不同测试责任；可以共享不可变 AST/raw snapshot，但不能简单调用 production detector 来生成自己的分母。
- 每个 declaration 在发现时获得独立稳定 ID，IR 通过 declarationIds 关联，不能仅靠相同路径文本事后猜测对应关系。
- IR 先产生，覆盖后判定，最后才投影。
- 渲染聚合不得修改底层事实。
- 任何阶段失败都要保留诊断和已声明范围，不能输出完整声明。

## 5. Raw Source Snapshot、Census 与 Submodule

### 5.1 原始快照先于源码筛选

Census 必须直接来自：

- 本地文件系统/Git tree 的原始条目流；或
- GitHub archive 的原始 entry stream。

不能从当前 `isArchitectureSourcePath` 过滤后的 sources 反向构造。原始条目包括但不限于：

- 未知扩展名和 extensionless executable；
- 测试、fixture、vendor、生成物；
- manifest、lockfile、`.gitmodules`；
- schema、migration、配置；
- 二进制、图片和字体；
- 当前不支持语言的源码。

本地和远程必须生成同一套 disposition 语义，并提供 parity fixtures。

### 5.2 RawEntryRecord

每个原始文件条目必须恰好有一个处理状态：

| 字段 | 含义 |
| --- | --- |
| `path` / `size` / `entryKind` | 路径、原始大小、file/gitlink/symlink 等 |
| `language` / `role` | 语言及源码/测试/生成物/manifest/lockfile/schema/binary 等角色 |
| `packageId` | 所属 package/workspace，无法归属时产生记录 |
| `status` | `inventoried`、`selected`、`excluded`、`unsupported`、`parse-error`、`not-required` |
| `reason` | generated、test、vendored、binary、用户排除、解析器缺失等 |
| `parser` | 实际解析器名称与版本；尚未进入解析阶段时不得伪造 parsed 状态 |
| `declarationIds` / `evidenceIds` / `omissionIds` | 与后续独立清单和证据关联 |

Lockfile 可以证明依赖声明，不能单独证明运行时数据库或外部调用。测试、生成物和第三方 bundle 的排除规则也必须进入 census。

### 5.3 原始资源边界

- 原始 entry 数、原始总字节、单 entry 大小与支持源码预算是不同安全边界；
- 所有边界在读取/展开前尽可能检查，并写入 receipt；
- 任一原始预算耗尽都阻止所有 publishable view 和 HTML，只允许诊断；
- 不能用 source filter 让原始大文件绕过 census 安全限制；
- 证据和 census 采用流式/分片写出，不能为了完整索引把全部内容无界保留在内存。

### 5.4 Submodule

GitHub archive 不包含 submodule 工作树，必须显式处理：

- 从 Git tree/gitlink 和 `.gitmodules` 记录 submodule 路径与固定 revision；
- 声明范围内 submodule 必须作为独立 fixed-SHA 输入获取并拥有自己的 snapshot/receipt；
- 获取失败或 revision 不明时产生 blocking `unresolved-submodule`；
- 用户明确排除时记录 `out-of-scope`，full 的声明名称和范围必须反映该排除；
- 不允许把 archive 中缺失的 submodule 内容当成“没有源码”。

## 6. Architecture IR v2

### 6.1 版本和兼容策略

M0 先建立版本化 IR/evidence envelope（schema-only），M1 才接入运行时并开始 dual-write：

- `architecture.ir.json` v2 是语义交换格式；
- `architecture.facts.json` v1 暂时由 IR 投影生成，继续保持 inline evidence 的 strict schema；
- 在 IR v2 出现前，不给 facts v1 强行加入 evidenceIds；
- Archify Document 是独立、允许有损的渲染格式；
- 无损对账只定义为 **IR + Evidence Index + Projection Manifest**，不承诺 facts v1/HTML 无损；
- 迁移期间比较 v1 投影与既有 fixture，记录所有有意变化，不以兼容为由保留误报。

### 6.2 DeclarationRecord

独立清单至少包含：

- `declarationId`、kind、owner、required/critical；
- framework、版本和 capability；
- source entry、evidenceIds；
- 声明的 route、entrypoint、operation、package、job、store 等原始信息；
- discovery extractor 名称和版本，必须与 semantic extractor 区分。

Semantic IR 通过 declarationIds 证明覆盖了哪些独立声明。缺少对应 IR 的 declaration 就是 missing，不能被另一个“相似节点”抵消。

### 6.3 节点与合成节点

分阶段支持：

- 组织：`repository`、`workspace`、`package`、`module`；
- 运行：`runtime`、`frontend`、`api`、`worker`、`cli`、`agent`；
- 交互：`route`、`handler`、`job`、`consumer`、`actor`；
- 资源：`database`、`object-store`、`queue`、`external`。

Actor 必须区分 user、scheduler、external caller 等角色。

节点至少包含稳定 ID、kind、显示 label、完整逻辑身份、owner、scope、sourcePaths、evidenceIds、resolution、confidence 和 synthetic/derivedFrom。

- 真实源码节点必须有直接证据；
- synthetic actor/view 节点可以没有直接源码位置，但必须有有效 `derivedFrom` fact/declaration IDs；
- 只有这类派生展示节点可豁免直接证据，不能用 synthetic 绕过真实事实门禁。

### 6.4 关系类型

在现有 HTTP/SQL/schedule 等类型上逐步增加：

- `contains`、`imports`、`calls`；
- `routes-to`、`handles`；
- `enqueue`、`consume`、`publish`、`subscribe`；
- `reads`、`writes`、`migrates`；
- `deploys`、`depends-on`。

每条边必须有 from/to、方向、kind、evidenceIds、declarationIds 和 target resolution。无法确定方向的调用不得强行写成 request/upload/download。

### 6.5 OperationFact：初版 IR 必须保留协议细节

IR v2 初版就定义可判别联合，不能等后期再破坏性补字段：

- `HTTPOperation`：method、path（若可知）、callSite、handler/client owner、target；
- `GraphQLOperation`：query/mutation/subscription、operation name、document hash、callSite、target；
- `QueueOperation`：enqueue/consume/publish/subscribe、topic/queue（若可知）、target；
- `SQLOperation`：read/write/transaction/migration、schema/driver、callSite、target；
- `ScheduleOperation`：schedule 定义、job owner、target；
- `ConfigBinding`：config key、默认值、override、使用位置及对应 target。

每个 operation 有稳定 ID、declarationIds、evidenceIds、candidate/omission links 和独立 TargetResolution。候选 schema 不再局限于 HTTP/GraphQL 的单个可选 operation。

### 6.6 TargetKind 与 Resolution 分离

外部目标的两个维度不得混用：

| 字段 | 值与含义 |
| --- | --- |
| `targetKind` | `host`、`service`、`protocol`、`queue`、`database`、`unknown` |
| `resolution` | `static`、`configured`、`dynamic`、`unknown` |

另外保存：

- config key（若可知）；
- 可选默认值及 evidence；
- 可选 override 及 evidence；
- target/protocol 的原始文本和推断规则；
- 每个 call/operation 自己的解析结果。

规则：

- configured host 的实际运行值仍然未知，必须明确披露；
- required env 没有默认值也可以是 configured，不必须有 default；
- protocol-only 只说明协议/模块，不伪装成 host；
- 动态 endpoint 或 federated ActivityPub 不因为缺少唯一 host 就必然无法完成 full；
- 普通 full 要求所有调用/operation 都有准确 targetKind/resolution 和动态披露，未知 egress 仍阻塞；
- 只有额外请求 `allExternalHostsResolved` 时，才要求每个外部目标解析为具体 host；无法达到时应明确失败，而不是改称完整。

静态默认值若可被环境覆盖，应记录 configured/dynamic，不能标成纯 static。

### 6.7 Evidence Index

新增独立 `architecture.evidence.json`：

- evidence 以 `path + startLine + endLine + extractor + role` 去重；
- 节点、边和 operation 保存 evidenceIds；
- 角色区分 `declaration`、`runtime-call`、`configuration`、`schema`、`migration`、`inferred-default`；
- parser evidence 与 regex evidence 明确区分；
- 完整证据保留在索引中，投影只选择代表性证据并记录选择原因和总数；
- 对路径级存储证据进行语义过滤，禁止把文件每一行都当成数据库证明；
- 采用流式/分片写出和原子替换，不能静默截断。

### 6.8 Omission

扩展原因：

- `unsupported-language`、`unsupported-framework`、`unsupported-protocol`、`unsupported-syntax`、`parser-unavailable`；
- `parse-error`、`unresolved-import`、`unresolved-handler`、`unresolved-submodule`；
- `unknown-identity`、`uncertain-direction`；
- `generated`、`test-only`、`out-of-scope`、`duplicate`；
- `budget-exceeded`（只作为全量失败诊断）。

每个 omission 包含 owner、declarationIds、evidenceIds、影响视图和按规范矩阵确定的 blocking。实现者不得为了让某个样本通过而自行改成 non-blocking。

## 7. Project Preparation 与 LanguageAdapter

### 7.1 不可变 raw source 与项目级上下文

当前带行号的 source content 不能直接作为 parser 输入。必须分离：

- immutable raw bytes/text：用于 AST、hash、parser；
- numbered view：只用于 evidence 展示和行号映射；
- source snapshot ID：供 census、adapter、helper、cache 共用。

Adapter 不能只有 per-file API，必须先有项目准备层：

```ts
interface LanguageAdapter {
  id: string;
  version: string;
  prepareProject(snapshot: SourceSnapshot, context: BuildContext): ProjectUnit[];
  parseProject(project: ProjectUnit): ParseProjectResult;
  declarations(project: ProjectUnit): DeclarationRecord[];
  symbols(project: ProjectUnit): Symbol[];
  imports(project: ProjectUnit): ImportRef[];
  entrypoints(project: ProjectUnit): EntrypointCandidate[];
  capabilities(): AdapterCapability[];
}
```

Declaration discovery 与 semantic extraction 在实现中仍须保持独立模块和分类逻辑，不能因为接口集中而共享同一个“是否像路由”的 detector。

### 7.2 TypeScript / JavaScript

第一批实现：

- TypeScript Compiler API 与 `Program`/compiler host；
- package.json、workspace、tsconfig paths、project references；
- import/export/re-export、动态 import；
- 函数、class、method 和调用表达式；
- Next.js App Router route/page、Vite 入口；
- route registration 到 handler 的解析；
- 需要类型解析时使用项目级 Program，无法证明时产生 omission。

正则仅作为协议文本和辅助证据，不能替代 AST。

### 7.3 Go

第一批实现：

- go.mod、workspace/replace、module 和 package 清单；
- package-aware Go AST/parser、import、function、method、call expression；
- main package、HTTP route、handler、storage call；
- receiver/type 的简单解析和跨文件常量；
- `NewRequest` → `Do` 的符号级关联，替代仅按变量名和行号匹配；
- 有界类型/SSA 分析只在能够证明关系时使用，否则 omission。

构建上下文要求：

- GOOS、GOARCH、tags、workspaces/replace 明确记录，不继承宿主机隐式默认；
- helper 只读、离线，不执行仓库代码，不自动 `go mod download`；
- helper 与 census/evidence 使用同一 immutable snapshot；
- 工具缺失时只能发布满足既有门禁的 Runtime Overview，不能发布 Module Architecture。

解析方案先做小型 ADR/性能对比：真实 Go parser helper 或固定 Tree-sitter/WASM。选择后必须固定版本、测试跨平台和记录能力，不为了 Node-only 退回不完整正则并宣称完整。

### 7.4 打包与运行时依赖

当前 `typescript` 是 devDependency，不能直接成为已打包 CLI 的隐式生产依赖。实施时必须：

- 将选定 parser runtime 固定为 production dependency，或有意识地 bundle；
- 记录 parser/distribution/build-context 版本并纳入 cache key；
- 增加 `npm pack --dry-run`；
- 在临时目录进行 production install smoke test，只安装包及生产依赖后运行 fixture；
- 测试 Go helper/parser unavailable 行为；
- 保持现有无 parser 的 Runtime Overview 使用边界，不悄悄提高其安装要求。

### 7.5 后续语言

Python、Java/Kotlin、Rust、C# 仅在统一 IR、覆盖和黄金评估稳定后增加。每种语言必须提供 adapter capabilities、正负 fixture、fixed-SHA 公共仓库、人工审核样本和 parser unavailable 测试。

## 8. Module、Route、Call 与 Protocol

### 8.1 ModuleGraph

- 以 package/module 为主要粒度，不直接展开所有函数；
- import 解析到真实 package/module；
- 记录 external package、内部模块和 unresolved import；
- owner 能追溯到 manifest、目录规范或源码声明；
- 处理 barrel、re-export、模块根 import 和 monorepo reference；
- 循环依赖保留，不为布局强行打破语义。

### 8.2 RouteGraph

- 从框架注册语法提取 method、path、middleware、handler；
- Next.js 文件路由和显式 router 注册使用不同 extractor，但进入同一 IR；
- handler 关联 module、storage、external 和 job；
- 动态 path、通配 route、group route 保留原始定义；
- 无法关联 handler 必须产生阻塞 `unresolved-handler`。

### 8.3 Call/Data-flow 摘要

- 优先建立 exported symbol、handler 和跨模块调用；
- 不追求整仓全函数调用图；
- 对配置常量、简单字符串拼接、默认参数和跨文件字段赋值建立有限数据流；
- 动态 dispatch、反射、依赖注入无法确定时保留候选或阻塞 omission；
- 任何摘要都必须能展开到原始证据。

### 8.4 ProtocolExtractor

第一批完善 HTTP、GraphQL、SQL、Worker/Scheduler/Queue/Pub/Sub、Webhook/callback、OAuth/OIDC、ActivityPub。后续再扩 gRPC、WebSocket、对象存储和云消息协议。

规则：

- 可以根据库名识别依赖，但不能根据仓库名生成架构；
- provider 名称不能替代运行时调用；
- operation 级事实永远保留，聚合只发生在视图层；
- 新增 extractor 必须同时扩展独立 declaration/protocol-capability discovery 和 mutation test，不能自己同时决定“存在什么”和“已经覆盖什么”；
- 独立 discovery 检测到尚未支持的协议时必须产生 `unsupported-protocol`；通用 HTTP 网络候选不能充当该协议的 operation coverage。

### 8.5 移除专用 external 旁路

设置独立迁移 PR，逐步移除：

- `external.ts` 中硬编码服务规则；
- generic external 的 reserved identity suppression；
- 已知服务绕过 candidate/operation 的特殊路径。

已知和未知 provider 必须进入同一协议/网络提取与 target resolution 流程。节点去重通过通用 canonical target/identity 规则完成，不靠厂商黑名单。迁移前后必须比较证据，允许有意修正节点身份，但不能丢失 operation。

Framework parser 与 external-service identity detector 是不同职责，不得借“通用化”删除必要的框架语法解析。

## 9. 独立覆盖、Mutation Test 与发布矩阵

### 9.1 覆盖输入

覆盖至少来自四个独立来源：

1. Raw Census：原始条目、package、语言、解析状态；
2. DeclarationInventory：独立发现的 route、entrypoint、operation、job 等声明；
3. Architecture IR：节点、关系、operation、证据和 omission；
4. 版本化 Gold Standard：人工确认的外部真值。

Declaration discovery 不得简单调用 production semantic detector。共享 AST 可以，分类逻辑、 declarationId 和测试责任必须独立。

### 9.2 Mutation tests 证明分母独立

每类 critical declaration 必须有 mutation test：

- 禁用 production route/entrypoint/protocol extractor；
- 独立 DeclarationInventory 仍保留 declaration；
- coverage 因此报告 missing 并阻塞；
- 如果禁用 extractor 后分母也变成 0，测试失败，说明覆盖仍相关。

再增加未知框架和未支持协议 fixture：如果 declaration/protocol-capability discovery 无法识别能力，必须产生 capability gap；检测到 gRPC、WebSocket、对象存储或云消息但尚无对应 extractor 时，必须产生阻塞 `unsupported-protocol`。不得报告 route/operation total 0 后通过 full，也不得用一个通用网络候选冒充协议 operation 覆盖。

### 9.3 覆盖矩阵

每个视图分别计算：

- raw entry selected/excluded/unsupported；
- source parsed/parse-error/parser-unavailable；
- package assigned/unassigned；
- runtime covered/missing；
- module covered/unresolved；
- route mapped/unresolved；
- worker/consumer covered/missing；
- store driver/schema/migration/relationship covered；
- external targetKind/resolution/unknown；
- protocol supported/unsupported 与 operation declaration covered/missing；
- edge evidence valid/missing/uncertain-direction；
- declaration covered/missing；
- parser failures 和 capability gaps；
- blocking omissions。

### 9.4 规范性 blocking 矩阵

| 条件 | system | runtime | module | flows | full |
| --- | --- | --- | --- | --- | --- |
| raw budget/archive/submodule 必需输入失败 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 |
| 未知 egress / 无证据外部调用 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 |
| runtime/deployable 必需声明缺失 | 视范围 | 阻塞 | 阻塞 | 视范围 | 阻塞 |
| parser unavailable / unsupported syntax（声明范围内） | 可降级披露 | 视既有能力 | 阻塞 | 阻塞 | 阻塞 |
| 检测到 unsupported protocol（声明范围内） | 视协议边界 | 记录并披露 | 视 owner | 阻塞 | 阻塞 |
| package 未归属 / unresolved import | 不直接 | 记录 | 阻塞 | 视影响 | 阻塞 |
| unresolved route/handler | 不直接 | 记录 | 阻塞 | 阻塞 | 阻塞 |
| critical operation/worker/queue 声明缺失 | 不直接 | 记录 | 视 owner | 阻塞 | 阻塞 |
| dynamic/configured target 已披露 | 不阻塞 | 不阻塞 | 不阻塞 | 不阻塞 | 不阻塞 |
| `allExternalHostsResolved` 下仍有动态目标 | 视请求 | 视请求 | 视请求 | 视请求 | 阻塞该严格门禁 |
| critical gold fact 缺失或方向/证据错误 | 阻塞对应评估与发布 | 同左 | 同左 | 同左 | 阻塞 |

“记录”不等于从分母删除；是否影响其他视图必须按 owner 和传播关系计算。任何 critical omission 都不能通过人工确认变成 covered。

### 9.5 发布规则

- Runtime Overview 可以发布，但必须标记为概览；
- full-declared-scope 要求所有声明视图和独立 mutation tests 通过；
- 任何隐藏截断、未知证据端点、无证据边、未知 critical omission 都阻塞；
- 视觉通过不能改变语义状态；视觉与 corpus/性能检查属于视图交付和 generator release qualification，不是任意单次输入设置 `fullArchitecture` 的隐含前提；
- 输出必须显示未覆盖声明和 capability gap，而不只是绿色状态。

## 10. Projection Manifest、输出与视觉验收

### 10.1 计划输出

```text
architecture.source-census.json
architecture.declarations.json
architecture.ir.json
architecture.evidence.json
architecture.candidates.json
architecture.coverage.json
architecture.views.json
architecture.overview.json
architecture.overview.html
architecture.modules.<runtime>.json
architecture.modules.<runtime>.html
architecture.flows.<runtime>.json
architecture.flows.<runtime>.html
architecture.analysis.json
repomap.receipt.json
```

现有 facts/Archify 文件在迁移期保留为可能有损的兼容投影。输出由 manifest 管理，不能无控制地写数百个 HTML。

### 10.2 Projection Manifest 是无损对账的一部分

`architecture.views.json` 必须记录：

- 每个 projected node/edge/page 对应的**完整有序 IR fact IDs**；
- 每个投影实体对应的 declarationIds、operationIds；
- page membership、分页总数和顺序；
- 选中的 representative evidenceIds、选择原因和 evidence 总数；
- 被聚合实体的完整列表，而不是只写 `×10`；
- 投影 schema、IR schema、parser 和 generator 版本。

分页必须互不重叠且并集完整。验证器执行 IR → manifest → projection 的 round-trip accounting，任何缺失、重复或悬空引用都失败。

facts v1 和 HTML 可以只展示代表性信息，但不能静默 slice 后假装无损；无损保证只针对 IR + evidence + manifest。

### 10.3 视图策略

- System Context：用户、产品和外部边界；
- Runtime Overview：当前层级，展示 runtime 与资源；
- Module Architecture：按 runtime/package 展开内部模块；
- Protocol Detail：按 route、GraphQL operation、queue topic 或 job 展示；
- 每个详图有明确 owner 和声明范围；
- 总览节点可以定位到详图 manifest；
- 超大模块按业务域/包分页，全部分页由 manifest 枚举；
- `--no-render` 不生成 HTML，但仍需完成 JSON projection 和 round-trip 校验。

### 10.4 视觉验收

- 每种视图分别做 render/browser checks；
- 检查浅色、深色、不同视口和长标签；
- 检查节点索引、详图链接和分页完整性；
- 截图人工审核仍是独立步骤；
- `--no-render` 下这些视觉状态为 `not-requested`，不阻塞 per-input semantic full，但在请求视觉交付或 generator release qualification 时必须完成；
- 不以视觉“看起来丰富”作为语义目标。

## 11. Harness / LLM 接续边界

默认 CLI 始终保持确定性，`aiRequests: 0`。

未来 Harness 只能读取 unresolved candidates 和必要源码切片，提议模块命名、协议分类或配置身份解释，并为每个修改提供原始证据和独立增强回执。

Harness 不得：

- 删除 unknown 或 blocking omission；
- 生成无证据节点和关系；
- 修改 raw census、declaration inventory、fixed revision 或原始回执；
- 自行宣布覆盖完成；
- 把 configured/protocol 目标升级为 static host，除非有新的源码证据。

增强结果必须重新经过同一独立覆盖评估和 critical recall 门禁。

## 12. 测试、黄金语料与性能验收

### 12.1 测试层级

1. Schema/单元测试：IR、declaration、operation、证据索引、identity、omission、投影；
2. Raw census parity：本地/GitHub、未知语言、extensionless、二进制、vendor/test、submodule；
3. Parser fixture：正常语法、动态语法、解析失败、别名、re-export、泛型、receiver、build tags；
4. Protocol fixture：正负例、方向、未知目标、注释和文档误报；
5. Independence mutation：禁用 extractor 后 declaration 仍在且 coverage 失败；
6. 集成测试：fixed-SHA、视图状态、退出码、输出 manifest、no-render；
7. 黄金评估：人工确认节点/边/方向/证据；
8. 生产安装、性能、安全和视觉回归。

### 12.2 版本化 Corpus Manifest

建立 `evaluation/corpus.json`，每项至少包含：

- owner/repository、完整 40 字符 SHA；
- archive SHA-256（已取得时）；
- gold schema/version 和审核文件；
- parser/build context；
- requested views 与每视图预期状态；
- critical declaration IDs 和必须覆盖的事实；
- 是否 release-gating；
- 性能基线版本和阈值。

Easy Make PPT 当前依赖本地 clone，只能作为非 gating 开发样本，除非提供可复现的公开 fixed-SHA 输入。M7 的发布门禁不得依赖只存在于某台机器上的仓库。

### 12.3 固定语料用途

| 语料 | 主要验证点 |
| --- | --- |
| Authelia 固定版本 | 大型 Go + Vite、多个 main、模块闭包、多 SQL 方言、GitHub/Docker 外部调用 |
| WriteFreely 固定版本 | 根 Go module、handler、ActivityPub/OAuth、MySQL/SQLite、lockfile 误报 |
| Commerce 固定版本 | Next.js route/UI/API、GraphQL operation、动态 provider identity |
| 可复现 Worker/Queue 公共样本 | 异步方向、consumer/producer、对象存储 |
| 小型库 fixture | 没有 deployable 的库不能被强行画成服务 |
| 多 workspace monorepo | package 归属、跨包 import、重复模块名 |
| 未知框架/SDK fixture | capability gap 或网络候选，不允许分母归零 |
| 动态/反射 fixture | 无法确定时阻塞 omission，不猜事实 |
| parser unavailable fixture | Runtime 与 Module/Full 的发布状态必须区分 |
| submodule fixture | 固定 revision、单独输入、未解析和用户排除语义 |

### 12.4 黄金答案与精确指标

- Gold Standard 从第一个受影响 fixture 起随 milestone 增量建立，M7 只整合，不事后补造；
- critical runtime/route/job/store/external 做穷举审计；
- 普通模块和调用做固定规则分层抽样；
- 分别计算 node/edge/operation precision、recall、方向正确率和语义证据有效率；
- **generator release qualification 对 critical gold 节点、边、方向和 operation 细节要求 100% recall、100% precision、100% 语义证据有效率，已知 critical false positive 为 0，omission 不抵扣**；
- 输入绑定了 Gold Standard 时，任何 critical mismatch 也阻塞该输入的 per-input full；
- 有效 revision/path/line 只证明位置可解析，不证明证据在语义上支持该事实；
- 所有发布事实必须有有效 revision、路径和行号，合成节点按 derivedFrom 校验；
- 误报与漏报分别记录，不能用总数相等抵消；
- 每个 corpus manifest 明确 required critical IDs，禁止只比较节点总数。

### 12.5 负例重点

- lockfile 中出现 postgres/mysql 不等于使用数据库；
- CI cron 不等于 runtime Worker；
- 文档 URL、注释和入站 server 不等于外部依赖；
- `NewRequest` 不等于实际发送；
- schema 存在不等于每个 runtime 都连接该数据库；
- `sql.Null*`、ORM tag 不等于真实存储调用；
- 文件名含 worker/oauth 不等于存在运行时行为；
- dynamic/configured/protocol 目标不等于已知 host。

### 12.6 性能、可靠性与安全阈值

在固定 CI runner 上，使用同一 archive/cache 状态至少三次运行，记录中位数和最差值。M1 固化基线，M2 起执行回归；没有数值基线的仓库不能成为 release-gating 性能样本。

首个 Authelia 提议门槛（M1 可根据真实测量收紧，不能无评审放宽）：

- 1,360 个支持源码文件、7.47 MB 源码必须完整处理；
- cached、`--no-render` 中位耗时不超过 60 秒，最差不超过 90 秒；
- RepoMap 主进程峰值 RSS 不超过 1 GB；外部 helper 单独记录，不能隐藏内存；
- 总 JSON 输出不超过 250 MB，单证据索引不超过 100 MB；超过即失败并诊断，不能截断；
- 相对已评审基线，耗时/RSS/输出大小回退超过 20% 需要性能审查；
- evidence/census 使用流式或分片写出，输出限制不是内存保留完整大字符串的理由。

其他 corpus 在 M1/M2 建立各自数值门槛。性能测量不能改变语义预算或允许跳过文件。

继续保持 archive 路径穿越、符号链接、损坏归档、超时、限流、缓存版本、原子写入和清理测试；不提交生成输出、runtime、credentials 或私有文档。

## 13. 分阶段实施与 PR 拆分

每个阶段按“失败测试与最小 gold → 实现 → mutation/coverage → 真实仓库 → 评估 → 文档”完成。阶段未通过时只能交付较低视图等级。

### M0：契约、CLI、IR Envelope 与初始 Gold

**改动**

- 引入 view、requested/required scope、capabilities、per-view receipt/exit semantics；
- 建立版本化 IR/evidence/declaration envelope（M0 仅 schema）；
- bootstrap 独立 DeclarationInventory 接口、稳定 declarationId、最小 Coverage Evaluator 和 mutation harness，先用内存 fixture 验证独立性；
- 当前输出标记 runtime-overview，`fullArchitecture` 默认 false；
- 定义 include/exclude、no-render、strict host gate；
- 为现有三个样本建立最小版本化 gold manifest。

**测试**

- 旧 facts 可读取，IR/evidence/declaration schema 可验证；dual-write 在 M1 才接入；
- 内存 mutation fixture 中禁用 semantic extractor 后 declaration 仍保留，最小 coverage 能报告 missing；
- Runtime 可发布时 full 仍不可宣称；
- full 请求失败时退出非零，但较低视图状态不伪造成总成功；
- no-render 不调用 Archify/Chromium。

**退出条件**：交付语义和版本边界明确，无现有提取语义变化。

### M1：Raw Snapshot、Census、Evidence 与门禁骨架

**改动**

- 从原始文件树/archive entry 建立 census；
- 原始资源预算和 submodule 语义；
- immutable raw source 与 numbered evidence view 分离；
- 独立 evidence schema/index，IR 与 facts v1 dual-write；
- 将 M0 bootstrap 的 DeclarationInventory、最小 Coverage Evaluator 和 mutation harness 接入 raw census，后续 M2–M4 每个 extractor 同步扩展；
- per-view omission impact 骨架；
- 文件角色与 lockfile/manifest/runtime evidence 分离；
- 修复 WriteFreely PostgreSQL lockfile 误报和证据膨胀；
- 建立 Authelia 数值性能基线。

**限制**

- 在 adapter 尚未接入前，只能标记 inventoried/selected/excluded 等已确定状态，不能伪造 parsed。

**测试**

- raw entry 对账、本地/远程 parity、未知语言/extensionless/binary/submodule；
- raw budget 失败时所有视图和 HTML 失败；
- lockfile 负例；
- evidence 引用无悬空、流式/分片输出无截断。

**退出条件**：所有原始条目有 disposition，已知误报消失，视图门禁骨架可用。

### M2：Project Preparation、Operation IR 与 ModuleGraph

**改动**

- 项目级 adapter/prepareProject、raw parser input；
- 初版 OperationFact 和 TargetKind/Resolution；
- TypeScript Program、Go package-aware parser；
- TS/Go module/import graph；
- unresolved import 和 parser capability；
- facts v1 投影适配；
- parser 生产打包与 production-install smoke test。

**测试**

- barrel、alias、模块根 import、循环依赖、build tags；
- 多 workspace 重名模块；
- parser unavailable 只阻断相应视图；
- operation/config/target schema 初版即可表达后续协议细节；
- packed CLI 在生产安装后运行成功。

**退出条件**：三个主样本生成有证据的模块图，operation IR 不需要破坏性重设计。

### M3：Route/Handler、有限调用与通用 External 统一

**改动**

- Next.js/Vite/Go HTTP route extractor；
- route → handler → module → store/external/job；
- 跨模块导出符号和有限调用摘要；
- unresolved handler/dynamic dispatch omission；
- 移除硬编码 external rules 和 reserved identity suppression；
- 已知/未知 provider 共用协议与候选路径。

**测试**

- method/path/group/middleware、动态路由、re-export、alias；
- handler 不存在或多候选时 fail closed；
- 已知 provider 不丢 operation，未知 provider 不消失；
- 无厂商黑名单去重；
- 对应 gold 在 M3 同步扩展，不等 M7。

**退出条件**：关键 route 全部映射或 full 阻塞，专用 external 旁路不再决定发布结果。

### M4：异步、数据流与身份解析

**改动**

- Worker/Scheduler/Queue/Pub/Sub IR；
- enqueue/consume/publish/subscribe 方向；
- SQL 读写/migration 归属；
- TargetKind/Resolution、config key/default/override；
- 跨文件常量、配置默认值和简单字段数据流。

**测试**

- CI schedule 负例；
- enqueue/consume 方向；
- 无默认值 required env 和可覆盖默认值；
- 动态/federated target 披露与普通 full、严格 host gate 的区别；
- 未知 SDK、动态 dispatch 和 unknown egress 阻塞。

**退出条件**：异步黄金样本有明确结论，WriteFreely 外部目标按两个维度准确发布。

### M5：Declaration/Coverage 完整矩阵与聚合门禁

**改动**

- 扩展并统一自 M0/M1 已运行的独立 declaration discovery、declarationId 和分类逻辑，而不是到本阶段才引入独立分母；
- source/package/module/route/async/store/external/edge 覆盖矩阵；
- view-specific blocking matrix；
- full-declared-scope 聚合门禁；
- capability gap 与 unknown framework 处理；
- 完整 independence mutation suite，包括 unsupported protocol 和 protocol-capability discovery；

**测试**

- 禁用 extractor 后 declaration 仍在、coverage 失败；
- 禁用 extractor 后若分母归零则 mutation 自身失败；
- 未知框架不能使 route total 0 后通过 full；
- critical omission 不可被人工审核改成 covered；
- 覆盖分母不可由渲染投影生成。

**退出条件**：每个视图声明可解释、可复现、可审计，分母独立性经过突变证明。

### M6：多视图与无损 Projection Manifest

**改动**

- overview/module/flow manifest；
- 完整 IR-fact 反向映射、分页与 evidence 选择记录；
- 可逆 GraphQL/queue 聚合；
- receipt 记录每个视图状态；
- round-trip accounting。

**测试**

- 大模块分页并集完整、互不重叠；
- 总览与详图使用同一 IR；
- operation 展开后 declaration/evidence 一致；
- facts v1/HTML 被明确标记为有损兼容投影；
- 深浅主题和浏览器检查。

**退出条件**：三个主样本均有概览与至少一个有实际语义的模块详图，投影可完整对账。

### M7：黄金评估、性能与发布候选

**改动**

- 整合从 M0 起增量维护的 Gold Standard；
- 固定公共 corpus manifest、审核记录和必要公共异步样本；
- 性能、安全、生产安装和失败矩阵；
- 文档、SKILL 和发布说明同步。

**测试**

- critical gold 节点/边/方向/operation 100% recall、100% precision、100% 语义证据有效率，已知 critical false positive 为 0，omission 不抵扣；
- 节点/边/方向/证据分别报告；
- Authelia 数值性能门槛及其他 corpus 基线；
- 全量 typecheck/test/build/Markdown/diff/secret scan；
- fixed-SHA 真实仓库与视觉复核。

**退出条件**：单次输入只有声明范围全部通过时才设置 `fullArchitecture=true`；generator release qualification 另由 corpus、性能、生产安装和视觉评估报告确认。full 请求失败时，较低视图可以保留自身状态，但命令非零退出。

### M8：扩展语言与可选 Harness

在 M0–M7 稳定后逐项增加语言或 Harness，不与核心重构混在一个 PR。每个扩展重复 adapter、负例、公共仓库、生产安装和黄金评估流程。

## 14. 依赖关系与推荐 PR 顺序

```text
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8
  ↓      ↓      ↓      ↓      ↓
  最小 gold 和独立覆盖从各阶段同步增长，不能等 M5/M7 才补
```

建议 PR：

1. `docs/contracts`：本计划、view、CLI/receipt；
2. `ir-envelope`：版本化 schema、独立 declaration/coverage/mutation bootstrap（不做 v1 dual-write）；
3. `raw-source-census`：原始条目、预算、submodule、parity；
4. `evidence-index`：角色、去重、流式输出和 facts v1 dual-write；
5. `project-preparation`：raw parser input、生产依赖；
6. `ts-module-graph`；
7. `go-module-graph`；
8. `operation-ir-and-targets`；
9. `route-and-call-graph`；
10. `generic-external-unification`；
11. `independent-declarations-and-coverage`；
12. `multi-view-manifest`；
13. `gold-performance-release`。

不要把整个计划做成一个巨型 PR。每个 PR 必须保持可回滚，并同步增加受影响 fixture 的 gold 与 mutation test。

## 15. 三个现有样本的专项审计要求

### Authelia

- 每个 main package 有稳定 runtime 和完整逻辑身份；
- 大 import 闭包拆成有证据的 package/module；
- Vite 前端与 Go 服务关系必须由调用证据支持；
- MySQL/PostgreSQL/SQLite 关系按 runtime 证据归属，不全连接；
- CI、suites、generator 和真实产品 runtime 分开；
- 未识别 Worker/内部关系必须形成 declaration/coverage 结论，而不是显示 0 后结束。

### WriteFreely

- 根 package 中的 handler、OAuth、ActivityPub、storage 等成为内部模块；
- 内部 OAuth 模块与外部 OAuth 提供者是不同节点；
- 动态/federated target 明确披露，不描述成已知 host；
- MySQL/SQLite 证据和 migration 归属准确；
- `prose/package-lock.json` 不再创建 PostgreSQL 数据库；
- 外部操作保留 method、发送行和 targetKind/resolution。

### Commerce

- 页面、route、server function 和 Shopify client 有模块关系；
- GraphQL operation 在详图中逐项可见，方向正确；
- 总览仍可聚合，但 manifest 能展开全部 operation；
- PostgreSQL 节点需要重新确认真实 driver/config/runtime 证据；
- 未使用 provider 和未接入模块不得靠模板补全。

## 16. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 静态分析无法确定动态行为 | target/resolution 披露，未知 egress 阻塞，不猜 |
| detector 与覆盖共同漏报 | 独立 declaration discovery、mutation tests、人工 Gold |
| 用 omissions 抵扣漏报 | omission 永远不是 covered，critical recall 必须 100% |
| 原始文件在 census 前被过滤 | 从 raw tree/archive entry 开始，local/remote parity |
| AST 依赖增加安装复杂度 | 生产依赖/bundle、pack smoke test、parser unavailable 分级发布 |
| Go 构建上下文不确定 | 显式 GOOS/GOARCH/tags/workspace/replace，只读离线 helper |
| 模块图过大 | package/module 粒度、按 runtime 分页，IR 不截断 |
| 证据文件膨胀 | evidence index、语义去重、流式/分片写出和数值输出阈值 |
| 投影“可逆”只有口号 | manifest 保存完整 IR IDs，round-trip accounting |
| 为通过门禁降低标准 | 失败测试和 mutation 先行，覆盖变更必须评审 |
| 为“通用”保留厂商旁路 | 独立迁移删除专用 external/reserved suppression |
| 多视图各自产生语义 | 所有视图只能投影同一 IR |
| 巨型 PR 无法审查 | 小 PR、增量 gold、保持可回滚 |
| 视觉复杂被误当语义完整 | 语义评估与视觉检查分别报告 |

## 17. 最终 Definition of Done

### 17.1 单次输入的 Per-input Semantic Full

只有全部满足以下确定性条件，才可把本次输入标记为 `fullArchitecture: true`：

- [ ] fixed revision、raw snapshot、scope、build context、capabilities 和排除规则完整记录；
- [ ] 每个原始仓库条目和 submodule 都有 disposition；
- [ ] DeclarationInventory 与 semantic extraction 独立，mutation tests 证明分母不会随 extractor 一起消失；
- [ ] 每个必需 declaration、package/runtime/route/job/store/external 都有对应事实；
- [ ] 本次评估中已知 critical false positive 为 0；若输入绑定 Gold Standard，critical 节点、边、方向、operation 的 recall、precision 和语义证据有效率均为 100%，没有 omission 抵扣；
- [ ] 所有真实发布节点和关系均有语义上支持事实的有效证据，合成节点 derivedFrom 有效；只有路径/行号存在不算语义有效；
- [ ] 所有边端点、方向和 owner 经过校验；
- [ ] parser failure、unsupported framework/protocol/syntax、unknown egress 没有静默忽略；
- [ ] 动态/configured target 明确披露，严格 host gate 与普通 full 不混淆；
- [ ] 没有隐藏截断，分页和排除可由 manifest 对账；
- [ ] IR + Evidence + Projection Manifest round-trip 完整；
- [ ] 默认 `aiRequests: 0`，增强结果有独立回执；
- [ ] receipt 只对实际通过的视图声明发布，不越级宣称 full；
- [ ] `--no-render` 时视觉状态为 not-requested，不调用 Archify/Chromium，也不把视觉门槛偷换成单次语义门禁。

该状态不表示生成器已经通过发布资格，也不表示未绑定 Gold 的本地输入已经过黄金 precision/recall 验证。

### 17.2 Generator Release Qualification

只有独立发布评估全部满足以下条件，才可发布声称支持相应声明范围的生成器版本：

- [ ] 版本化公共 corpus 可复现，本地-only 样本不作为发布硬依赖；
- [ ] critical gold 节点、边、方向和 operation 的 recall、precision、语义证据有效率均为 100%，已知 critical false positive 为 0；
- [ ] unsupported protocol/framework 的 capability discovery 和 mutation fixtures 通过；
- [ ] 大仓库数值性能、内存、输出大小、缓存和清理回归通过；
- [ ] production-install smoke test 通过；
- [ ] 请求视觉交付的视图完成自动渲染、浏览器和人工视觉检查；
- [ ] typecheck、test、build、链接、diff 和 secret scan 全部通过；
- [ ] release qualification 有独立报告，不能由某次 CLI 的 `fullArchitecture` 推断。

## 18. 当前决策与下一步

当前 `8a92044` 是大仓库读取和 Runtime Overview 的阶段性成果，不是通用完整架构目标完成点。

建议评审通过后立即执行 **M0 + M1**：先建立契约、版本化 IR envelope、独立 declaration/coverage/mutation bootstrap、原始条目 census、独立证据和 per-view 门禁骨架，同时修复 lockfile 误报与证据膨胀。随后再进入项目级 parser 和模块图。

不要先增加更多视觉节点，不要先扩更多语言，也不要等所有提取器完成后再补独立覆盖。
