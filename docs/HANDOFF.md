# RepoMap 接手文档

更新日期：2026-11-09

> 当前补充：项目已发布到 `https://github.com/gzhanlei/repomap`。已完成大仓库懒加载、Go/SQLite/PostgreSQL、Vite/React、Go 出站 HTTP、M0/M1 契约、census、独立声明、证据索引、M2 项目/模块图、M3 RouteGraph/统一 External、M4 Target/Config/SQL/异步 operation、M5 逐视图覆盖/独立 mutation/full-declared-scope 聚合门禁，以及 M6 多视图无损 Projection Manifest。当前全量检查为 33 个测试文件、182 项测试。通用完整架构的后续实施计划见 [full-architecture-plan.md](full-architecture-plan.md)。以下 2026-11-05 的接手记录保留作历史背景，后续状态以 README、通用协议文档、完整架构计划和 Git 历史为准。

## 已确认的产品边界

- Radar 暂时不提供系统架构图，也不外接架构生成服务。
- RepoMap 是独立开源项目，不做多租户、数据库、Web 服务、队列或 Radar 集成，只提供本地 CLI 和 `SKILL.md`。
- RepoMap 采用确定性静态分析，当前不调用 AI；不能通过增加 LLM 或扩大预算来掩盖缺失事实。
- Archify 固定使用 v3.2.0 MIT，仅作为渲染器。ZIP 与 SHA-256 位于 `vendor/archify/`。

## Radar 当前状态

- 已部署 `ee7b9af1d3a894ea4a208f1eb6e16c83f3c4fcfa`，回滚点为 `refs/backup/pre-ee7b9af`。
- Radar 分析只保存 Spec、发布和行为变化，不再读取架构源码或调用 Archify。
- 产品卡片只等待 `queued/running` 分析；Easy Make PPT 最新运行 `#7` 为 `succeeded`，已验证 `pending: false`。
- 旧架构页面和 API 均返回 404；历史数据库记录和文件未删除。
- 公网登录返回 200，服务为 `active`。

## RepoMap 当前实现

项目目录：`~/Documents/GitHub/repomap`

已有文件与能力：

- `src/cli.ts`：`analyze` 命令、GitHub/本地输入、fixed revision、`--no-render`、`--visual-check`、`--no-cache`、locale 和输出目录。
- `src/core/github/`：GitHub shorthand/URL 解析、HEAD 解析、codeload 单 archive 下载、按 SHA 的本地缓存和成本指标。
- `src/core/source/local.ts`：按需加载的有界源码清单、64 文件 LRU 内容缓存、完整 UTF-8 读取、行号、目录/文件/单文件/总字节限制，以及本地 Git HEAD 和脏工作区校验。
- `src/core/architecture/`：从 Radar 抽取的通用事实、信号、覆盖门禁、检测器、投影和布局；Radar adapter、数据库、专用模板及逐 blob loader 未带入。
- `src/core/analyze.ts`：写出 facts、analysis、Archify spec、HTML（可选）和 `repomap.receipt.json`；覆盖或渲染失败也保留诊断。
- `src/core/archify-*`：固定 Archify release 校验、准备、delivery 和 visual-check。
- 根目录包含 `README.md`、`SKILL.md`、MIT `LICENSE` 和测试。
- 当前没有账号、数据库、多租户、Web 服务或 AI 调用。

## M6 当前交付快照

- `src/core/architecture/view-manifest.ts`：overview/module/flow facts、分页、`aliasOf`、可逆 `aggregateOf`、operation/evidence 对账；原始 detail facts 合入 IR v2，IR `viewOwners` 与 manifest `detailOwners` 独立对账，node/edge 记录并校验 Archify `projectionId`，operation 通过 `relatedProjectionIds` 指向实际语义边。
- `src/core/architecture/view-delivery.ts`：`architecture.views.json`、每页 JSON/HTML、legacy overview-first `architecture.json/html` 和每页 Archify/visual-check receipt；no-render 页面使用相同 facts 的确定性 grid 布局。
- 详图按实际节点与出边打包；Go import 标签只在显示层压缩，完整 ID/path/evidence 保留。密集 fan-out 有确定性标签布局 fallback，单节点页使用 `Scope` synthetic alias 满足渲染器的最小组件数。
- 固定 SHA 最终输出目录（不在 Git 中）：`/Users/leihan/Documents/GitHub/repomap-output/m6-final-v5-authelia`（97 页）、`m6-final-v5-writefreely`（31 页）、`m6-final-v5-commerce`（5 页）。三者均 `accepted`、`fullArchitecture: true`、round-trip 零缺失/重复/dangling，自动 visual-check 全通过；已抽查代表性 light/dark 截图。
- M7 尚未完成：human-reviewed critical Gold、固定 CI 性能门槛、generator release qualification；M8 语言扩展与可选 Harness 未开始。

## 历史验证记录（2026-11-05）

最近一次全量本地检查：

- `npm run typecheck`：通过。
- 7 个测试文件、18 个测试：通过（历史记录；当前为 13 个测试文件、46 项测试）。
- `npm run build`：通过。
- `npm run archify:prepare`：通过，固定 ZIP 的 SHA-256 已验证。

真实 Next.js fixture：

- CLI 和真实 Archify delivery 成功，9/9 检查通过。
- `/tmp/repomap-demo-output/architecture.html` 为实际生成的自包含 HTML。
- Chromium visual-check 通过，浅色和深色截图已人工查看，布局和文字正常。
- 该 fixture 只有 3 个源码文件，`aiRequests: 0`，不能作为大型仓库语义完整性的证明。

公开 GitHub 验证：

- `octocat/Hello-World` 成功解析 HEAD 并下载 archive；共 2 次 HTTP 请求。
- 该仓库没有支持的源码，按预期返回覆盖失败，没有伪造架构。
- NameDict 的 codeload 返回 404；当前本地没有该私有仓库的 archive 权限。未借用生产凭据。

Easy Make PPT 固定版本验证：

- 使用临时 clone `/tmp/pptcreator-repomap`，检出 `bc307ea55f50cdb30b1c625405f6caea00296418`，未修改用户原工作区。
- 输出目录：`/tmp/repomap-ppt-output`。
- 当前结果：`facts-ready`，不渲染 HTML。
- 674 个源码文件、324 个目录、6,054,544 字节，耗时约 630ms，`aiRequests: 0`。
- 结果为 5 个节点、3 条关系，覆盖门禁为 `publishable: true`。
- **这不是语义完整性的证明。** 当前独立信号清单尚未识别 Worker、Bull/Redis 和对象存储，因此覆盖分母不完整，不能直接交付该架构图。

## 历史未提交与未发布状态（2026-11-05）

- RepoMap 是新建目录，尚未初始化 Git、配置远程仓库、提交、推送或发布 npm 包。
- 当前源码和 `vendor/archify/archify-v3.2.0.zip` 均保留在本地。
- `node_modules/`、`dist/` 和 `vendor/archify/runtime/` 是本地生成物，不应提交。
- 尚未运行 RepoMap 的 CRAP、dryer、mutation testing、Skill forward-test 或 `npm pack --dry-run`。
- 不应把当前状态称为已发布 MVP；它是一个经过局部验证、待语义补全的接手快照。

## 后续优先级

### P0：先补独立信号与语义覆盖

先写失败测试，再实现通用能力，禁止按 PPTCreator 名称分支：

1. **TypeScript Worker**：识别 `worker/index.ts` 等真实入口、Scheduler 根和 TypeScript import 闭包。
2. **Bull/Redis**：识别 `new Queue`、`queue.process`、Redis 读写和发布/订阅；明确 API 入队与 Worker 消费的方向。当前 `EdgeFact.kind` 没有 queue 专用类型，需要先决定语义，不能误写成 HTTP 或直接调用。
3. **对象存储**：检查 `lib/storage/providers/{tencent,aliyun,local}.ts` 等实现，区分上传、下载和本地文件存储，不能只识别构造器。
4. **独立信号分母**：上述 Worker、队列和存储必须先进入 signal inventory，再用 coverage 验证事实，避免“检测不到就等于不存在”。
5. 重新运行 Easy Make PPT 固定 SHA，人工检查节点、关系、异步方向和外部服务，不能只比较节点数量或截图。

### P1：可靠性与安全

- 使用用户明确提供的新凭据验证私有 GitHub archive，不能复用生产凭据。
- 补 archive 损坏、并发缓存写入、tar 路径穿越、符号链接、超时和 API 限流测试。
- 用真实 Git 仓库补 HEAD 匹配、HEAD 不匹配和脏工作区测试；当前部分验证使用 mock runner。
- 保留所有状态的 `elapsedMs`，并补渲染失败耗时断言。
- 检查错误文案与网络超时，避免重复状态码或泄漏响应中的敏感信息。

### P2：开源发布准备

- 初始化 Git 并选择远程仓库；确认生成目录均被忽略。
- 补 package repository/homepage 元数据、CI、更多固定 SHA corpus 和 `npm pack --dry-run`。
- 运行 CRAP、dryer、mutation testing，以及 Skill `quick_validate` 和真实调用验证。
- P0 语义问题未解决前，不发布 npm 包，不宣称所有仓库都具有完整语义覆盖。

## 明确不做

- 不做 Radar 架构入口或外部架构服务调用。
- 不做多租户、账号、数据库、Web 控制台或任务队列服务。
- 不用仓库名模板、LLM 补事实或更大预算掩盖语义遗漏。
- 不删除 Radar 历史架构数据；它只是暂不对用户提供。

## 接手命令

```bash
cd ~/Documents/GitHub/repomap
npm install
npm run typecheck
npm test
npm run build
npm run archify:prepare

# 重建 Easy Make PPT 固定版本（如果临时目录已不存在）
rm -rf /tmp/pptcreator-repomap /tmp/repomap-ppt-output
git clone --no-hardlinks ~/Documents/GitHub/PPTCreator /tmp/pptcreator-repomap
git -C /tmp/pptcreator-repomap checkout bc307ea55f50cdb30b1c625405f6caea00296418

node dist/cli.js analyze /tmp/pptcreator-repomap \
  --revision bc307ea55f50cdb30b1c625405f6caea00296418 \
  --no-render \
  --out /tmp/repomap-ppt-output
```

先阅读 `architecture.analysis.json` 的独立信号和覆盖缺口，再决定是否生成 HTML。
