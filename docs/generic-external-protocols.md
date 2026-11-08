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
3. `lib/`、`src/`、`services/`、`server/`、`clients/`、`providers/`、`integrations/` 下的服务目录或模块名。

规则：

- 静态 host 使用 host 作为节点 ID 和标签；
- 动态 endpoint 使用环境变量或模块身份，并在标签中标记 `动态 endpoint`；
- 候选必须同时具有运行时调用证据，单纯 import 不会自动创建外部系统；
- 无法确定身份时保留 `unknown` 候选和 omission，**阻止发布**，不生成貌似完整的图。

现有专用 external detector 保留，通用规则不会重复处理其已注册身份。

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

`/Users/leihan/Documents/GitHub/repomap-output/vercel-commerce-generic-v3`

结果：

- `external: 15/15`；
- `blockingOmissions: []`；
- Shopify 动态节点及 GraphQL query/mutation 关系均存在；
- 渲染检查 `errors: 0`、`warnings: 0`；
- 浏览器视觉检查通过，已人工查看深浅主题截图。
