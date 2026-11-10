# 通用外部协议与 Harness 接续

RepoMap 现在支持**不依赖服务商专用 detector 的外部依赖提取**。默认仍为确定性静态分析，`aiRequests: 0`；不向 LLM 请求补全缺失事实。

## 目标

解决两类此前无法可靠覆盖的问题：

1. 未注册的 SDK 或外部服务被静默漏掉；
2. GraphQL 操作过多时，节点和连线、标签以及视口可读性下降。

实现分为两层：

- `architecture.candidates.json`：完整候选与处理结果，供覆盖校验和后续 Harness 使用；
- `architecture.facts.json`：用于渲染的节点和聚合关系。

## 外部身份解析

按以下顺序确定外部身份：

1. 源码中的绝对 HTTP(S) host；
2. `*_DOMAIN`、`*_HOST`、`*_ENDPOINT`、`*_BASE_URL`、`*_URL`、`*_API_URL` 等环境变量；
3. `lib/`、`src/`、`services/`、`server/`、`clients/`、`providers/`、`integrations/` 下的服务目录或模块名；
4. Go 文件中明确的协议模块名（如 OAuth、ActivityPub、Federation、Webhook），仅作为动态协议身份，不伪装成已解析 host。

规则：

- 静态 host 使用 host 作为节点 ID 和标签；
- 动态 endpoint 使用环境变量或模块身份，并在标签中标记 `动态 endpoint`；
- 候选必须同时具有运行时调用证据，单纯 import 或请求构造不会自动创建外部系统；
- Go 静态常量 URL 可以解析 host；若环境变量可以覆盖默认值，保留 host 证据但仍标记 `dynamic: true`；
- 无法确定身份时保留 `unknown` 候选和 omission，**阻止发布**，不生成貌似完整的图。

### Go 出站 HTTP

通用提取覆盖：

- `http.Get`、`http.Post`、`http.Head`；
- `http.NewRequest` / `http.NewRequestWithContext` 与同文件后续 `client.Do(req)`、`http.DefaultClient.Do(req)`、`activityPubClient().Do(req)` 等实际发送调用；
- 同文件静态字符串常量、环境变量动态 endpoint，以及同变量多次构造时按调用位置选择最近的请求定义。

`NewRequest` 本身只是请求构造，不是网络调用证据。相对路径、注释、文档字符串和 `ListenAndServe` 不生成外部候选。协议模块身份只说明“该模块发起动态外部 HTTP 调用”，并不表示静态分析已经知道最终域名。

专用 external detector 和 reserved identity suppression 已移除。已知与未知 provider 共用候选、operation 和 target 解析路径；对象上传/下载、OAuth、Webhook callback 与本地 process integration 也在同一候选清单中保留方向，不再由厂商别名决定是否发布。

## GraphQL

识别协议文本中的：

- `query <Operation>`：生成 `download` 关系；
- `mutation <Operation>`：生成 `upload` 关系；
- `subscription <Operation>`：保留为 `http` 关系。

关系标签：

- 单操作：`GraphQL query getProducts`、`GraphQL mutation cartCreate`；
- 多操作：`GQL query ×10`、`GQL mutation ×4`。

聚合只影响展示。每个 operation 仍在 `architecture.candidates.json` 中保留独立身份、协议、操作名、动态状态和源码证据。

## 候选结构

```json
{
  "id": "external:lib/shopify/queries/product.ts:4:query-getProduct",
  "identity": "shopify",
  "dynamic": true,
  "protocol": "graphql",
  "operation": { "name": "getProduct", "kind": "query" },
  "status": "resolved",
  "evidence": {
    "path": "lib/shopify/queries/product.ts",
    "line": 4,
    "detector": "generic-graphql-operation"
  }
}
```

字段：

- `identity`：静态 host 或解析出的服务身份；
- `dynamic`：endpoint 是否依赖运行时配置；
- `protocol`：`http` 或 `graphql`；
- `operation`：可选操作名及类型；
- `status`：`resolved` 或 `omitted`；
- `reason`：未解决时保留的原因；
- `evidence`：路径、行号和检测器。

`architecture.candidates.json` 同时适用于已解决和未解决候选，便于 Harness 只处理需要语义补全的项。

## 覆盖与发布门禁

`architecture.coverage` 新增 `blockingOmissions`：

- 未覆盖的 critical candidate 会进入 `unclassifiedCriticalSignals`；
- 未解决身份会同时进入 `facts.omissions` 和 `blockingOmissions`；
- 任一 blocking omission 存在时，`publishable = false`，不会生成 Archify HTML。

因此，`publishable: true` 不再仅表示“已知规则都通过了”，还要求通用外部候选被闭合处理。

## 布局策略

- 外部资源列从 `x=1080` 调整为 `x=900`，避免小图被过度缩小；
- 多个同类型 GraphQL 操作按调用方、外部服务和方向聚合；
- 单操作保留完整操作名，多操作使用短标签；
- 聚合不会删除 operation 级证据。

在 `vercel/commerce` 上，10 个 query 和 4 个 mutation 由 32 条平行边聚合为每个运行时各一条 query、mutation 和 HTTP 关系，避免布局标签无法放置。

## Go 模块与 SQLite 补充验收

### Authelia 大仓库验收

固定 revision：`32b0bdac395efc707bc098757afa232177965736`

源码读取已改为按需加载和 64 文件 LRU 缓存，不再把整个仓库内容同时载入内存；GitHub 临时目录在分析完成或失败后统一清理。默认资源安全上限为 100,000 文件/目录、单文件 50 MB、总源码 500 MB、归档 500 MB，不把小型 AI context 预算当作仓库支持上限。

完整读取结果：1,360 个支持源码文件、255 个目录、7,474,801 字节。固定归档命中缓存时网络请求为 0。

此样本同时修复了通用语义问题：Vite/React 入口、Go import 闭包中的服务启动、PostgreSQL 方言和迁移、非 `github` 路径中的 GitHub API 调用，以及 CI schedule 被误判为运行时 Worker。纯 `sql.Null*` 类型和 `db:` tag 不再被当成真实 SQL 存储调用。

最终输出目录：`/Users/leihan/Documents/GitHub/repomap-output/authelia-final`

结果：

- `entrypoint: 5/5`、`deployable: 6/6`、`store: 89/89`、`external: 2/2`；
- `blockingOmissions: []`，`publishable: true`；
- 渲染 diagnostics 为 0，浏览器视觉检查通过；
- 已人工查看深浅主题截图。

这证明该大仓库不再因旧的 1,000 文件预算被拒绝，并不表示所有更大的仓库都可以无限读取；超过明确资源安全边界时仍会显式失败。

### WriteFreely 修复与验收

固定 revision：`8ff3647e9a094dbcf09c9c84d8e2305543ee5cfb`

修复的通用问题：

- Go 模块名本身的导入现在会包含模块根目录，避免漏掉根目录的 `app.go` 和 SQL 初始化；
- HTTP 入口增加 `mux.NewRouter` / `Serve(` 证据，避免 Go 服务被误标为 CLI；
- `CREATE TABLE` 不再单独作为 MySQL 身份依据，新增 MySQL/SQLite/PostgreSQL 分别识别；
- schema 按 SQL 方言和路径补充证据，迁移文件的完整匹配行纳入 `signalIds`；
- schema/migration 不再无条件产生“每个 runtime 到每种数据库”的密集关系；只有真实 SQL 调用边附加 schema，完全无调用时仅由主 runtime 承接迁移证据；
- `static/public/assets` 下的第三方发行 bundle 被排除，`src/` 中真实源码仍保留；
- Go 出站 `http.Get`、`NewRequest` + `Do`、静态常量、动态环境配置和协议模块身份已进入通用候选。

最终输出目录：`/Users/leihan/Documents/GitHub/repomap-output/writefreely-final`

结果：

- `store: 19/19`（纯 `database/sql` 类型引用不再产生假存储信号）；
- `external: 15/15`，`candidateSummary: { total: 15, omitted: 0 }`；
- ActivityPub、OAuth、Slack、版本检查和 receipts 调用均有真实发送行证据；
- `slack.com`、`version.writefreely.org` 等使用静态 host；OAuth/ActivityPub 使用明确标记的动态协议模块身份；`webmonetization.org` 有环境覆盖，因此虽解析到默认 host 仍标记为动态；
- `blockingOmissions: []`，Go HTTP 服务和 MySQL/SQLite 关系均可达；
- 渲染 diagnostics 为 0，浏览器视觉检查通过，已人工查看深浅主题截图。

**边界**：`external: 15/15` 表示当前提取到的调用候选均有身份和覆盖，不表示所有动态请求的最终域名都已静态确定，也不表示任意未知 Go SDK 都能自动识别。普通模块中无法识别身份的动态调用仍会产生 omission 并阻止发布。

## Harness 后续接续

默认 CLI 不调用 LLM。后续 Harness 可以在独立阶段消费候选并输出 enriched facts，建议保持以下边界：

```text
architecture.candidates.json
  → Harness 读取候选及必要的源码切片
  → architecture.enriched.facts.json
  → 独立证据与覆盖校验
  → ArchifyDocument
```

约束：

- enriched 输出继续使用现有 `architectureFactSetSchema`；
- `confirmed` 事实必须有真实路径和行号；
- 动态 endpoint 必须保留 `dynamic: true` 或等价的动态标签；
- 未解决候选不得被静默删除；
- Harness 不得用生成结果覆盖原始 `sourceReceipt` 或证据哈希；
- 模型、token、缓存和 `aiRequests` 必须记录在独立增强回执中，不得改写默认的 `aiRequests: 0` 静态回执。

推荐只让 Harness 处理动态身份、模块命名、关系分类和低置信度项，不让它自行宣布覆盖完成。

## vercel/commerce 验收样本

固定 revision：`f7521d57d29f0eb3d23c1399cf9bb299d61fcd21`

最终输出目录：

`/Users/leihan/Documents/GitHub/repomap-output/commerce-final`

结果：

- `external: 15/15`；
- `blockingOmissions: []`；
- Shopify 动态节点及 GraphQL query/mutation 关系均存在；
- 渲染检查 `errors: 0`、`warnings: 0`；
- 浏览器视觉检查通过，已人工查看深浅主题截图。
