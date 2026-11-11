# RepoMap 接手文档

- 更新日期：2026-11-12
- 代码基线：`a231a69`（273aa93 gold 评估、beb3c32 人工 Gold、e097293 性能门槛、4949b6e 热点修复、a231a69 migration 欠报修复）
- 远程仓库：`https://github.com/gzhanlei/repomap`
- 当前分支：`main`

> 本文描述当前可接手状态。早期 Radar、PPTCreator 和“尚未初始化/发布”的记录已过时，不再作为工作依据；需要追溯时查看 Git 历史。本文档提交位于上述代码基线之后。

## 1. 当前结论

RepoMap 是一个本地、确定性的架构分析 CLI。它从固定源码快照生成带证据的 Architecture IR、RouteGraph、ModuleGraph、SQL/Async operations、覆盖门禁和多视图 Archify 交付物。

已完成：

- M7 第一切片：targeted human-reviewed Gold 机制（`src/core/architecture/corpus-gold.ts`、`npm run gold:evaluate`）、fastapi-template 首个 59 条人工审核 Gold（`docs/gold/fastapi-template.v1.json`，7 个 precision scope，59/59 recall、0 FP）、固定性能门槛（`npm run perf:gate`，阈值来自 `docs/performance-baseline.v1.json`）。
- M0–M6：scope、census、独立 declarations、Evidence Index、IR v2、TypeScript/Go 项目图、RouteGraph、统一 External、Target/Config、SQL/Async operations、逐视图门禁、独立 mutation 和多视图无损投影。
- M8 第一个 Python 切片：项目准备、Tree-sitter/WASM、src-layout、import/module graph、CLI 入口和 module 详图。
- M8 第二个 Python 切片：FastAPI/Flask routes、常见 DB-API/SQLAlchemy/Alembic operations、asyncio/queue/Celery/broker operations 和 Python 外部 HTTP candidates。

尚未完成：

- M7 其余部分：更多 corpus 条目的 targeted Gold、把评估接入 CI、性能回归定位（见第 9 节）和 generator release qualification。
- Django、RQ、完整动态依赖注入/ORM/SSA，以及更多语言和真实仓库审查。
- 可选 Harness/LLM enrichment 尚未实现；默认分析保持 `aiRequests: 0`。

**`fullArchitecture: true` 只表示某个固定输入在声明范围内通过语义门禁，不表示所有 Python 项目均受支持，也不等于 M7 或发布资格完成。**

## 2. 不可改变的产品与安全边界

- 只做本地 CLI 和 `SKILL.md`；不做 Radar 集成、Web 服务、账号、多租户、数据库或队列服务。
- 不用 LLM 补事实，不用仓库名/vendor 专用分支伪装通用能力。
- 使用固定 40 字符 revision 和不可变 raw snapshot；未知身份、动态路由、歧义 ownership 必须形成 omission 并阻断相关视图。
- 独立 declaration inventory 必须在 extractor/parser 被禁用时仍保留；omission 不算 coverage。
- resource budget 只负责资源安全，不是语义完整性门槛，不能靠扩大预算或过滤信号隐藏遗漏。
- `GITHUB_TOKEN` 只能来自环境，不能写入命令参数、日志、receipt、HTML 或提交。
- 不提交 `node_modules/`、`dist/`、`.repomap/`、生成 HTML/截图、缓存、`.env`、凭据或 `vendor/archify/runtime/`。
- Archify 只渲染语义事实；自动 visual-check 通过不能替代语义审查。`visualReview: pending` 时必须实际查看截图。

## 3. 关键代码入口

| 路径 | 责任 |
| --- | --- |
| `src/cli.ts` | `analyze` CLI、fixed SHA、include/exclude、view、render/visual-check 参数 |
| `src/core/analyze.ts` | 分析、门禁、文件输出和 receipt |
| `src/core/architecture/extract.ts` | 项目图、RouteGraph、AsyncGraph、IR、evidence 和 omissions 汇总 |
| `src/core/architecture/census.ts` | raw source census 与声明范围 |
| `src/core/architecture/declarations.ts` | 独立 declaration inventory |
| `src/core/architecture/evidence-index.ts` | 稳定 evidence ID、完整索引和引用校验 |
| `src/core/architecture/ir.ts` | Architecture IR v2、operations、omissions |
| `src/core/architecture/coverage-matrix.ts` | 逐视图门禁和 full-declared-scope |
| `src/core/architecture/independence.ts` | extractor/adapter 禁用 mutation |
| `src/core/architecture/view-manifest.ts` | 多视图分页、alias/aggregate、projection 对账 |
| `src/core/architecture/view-delivery.ts` | 每页 JSON/HTML、Archify delivery 和 visual-check |
| `src/core/architecture/project/python-parser.ts` | Python Tree-sitter syntax facts |
| `src/core/architecture/project/python.ts` | Python import/module 解析 |
| `src/core/architecture/project/python-routes.ts` | FastAPI/Flask routes、APIRouter composition、独立 route declarations |
| `src/core/architecture/project/python-async.ts` | asyncio/Celery/broker operations 和独立 async declarations |
| `src/core/architecture/detectors/python.ts` | Python runtime entrypoints 和最近入口 ownership |
| `src/core/architecture/detectors/storage.ts` | store 信号、driver-aware SQL evidence 和 runtime/store 关系 |
| `src/core/architecture/sql-operations.ts` | 可执行 SQL operation 分类、ownership 和 driver 歧义 omissions |
| `src/core/architecture/detectors/generic-external.ts` | 通用外部协议候选及 Python HTTP call-site identity |
| `tests/python-protocols.test.ts` | Python 第二切片正负例、失败关闭和 independence fixtures |
| `scripts/production-smoke.mjs` | 打包后生产安装与 TypeScript/Go/Python smoke |

## 4. 当前 Python 能力边界

### 4.1 项目与 ModuleGraph

- 固定 `tree-sitter-python@0.25.0`、`web-tree-sitter@0.27.2`，与 Go 共享一次进程级 Tree-sitter 初始化，但 parser 实例隔离。
- 不执行仓库 Python，不读取宿主 Python、virtualenv 或 installed packages。
- 支持 src layout、package、`__init__.py`、`__main__.py`、main guard、绝对/相对 import、嵌套/future import。
- 支持字面量 `importlib.import_module`、`__import__`、aliases、re-export、wildcard export 和静态 `__all__`。
- 动态 import、workspace 歧义、relative escape、unsupported `__all__` 和 parser-unavailable 均失败关闭。

### 4.2 FastAPI/Flask routes

- decorator route、多个 HTTP methods、本地 handler 和 direct calls。
- 跨文件 `APIRouter` composition，包括静态 prefix 和 `settings.API_V1_STR` 这类模块常量。
- route declarations 按 receiver 独立识别 FastAPI/Flask；普通 `@registry.get` 不进入 route 分母。
- 动态 path/method、循环或歧义 prefix、unresolved include/factory 会产生 omission。
- 普通对象的 `include_router` 不会被误判为 FastAPI，也不会无故阻断全图。

### 4.3 SQL / Alembic

- 常见 DB-API、SQLAlchemy/SQLModel read/write/transaction/migration operations。
- 支持 `session.get/exec/query` 和多行 SQL 上下文分类。
- import、schema 声明和 `create_engine` 只支撑 store/schema coverage，不生成伪造的 runtime operation。
- Alembic `op.*` 调用归执行它的 runtime；纯 schema resource 可归 store。
- 多数据库下，driver-neutral 或 driver 歧义调用不会扇出到多个 store，而是生成阻断 omission。
- object-store 不参与 SQL database 数量判断。

### 4.4 Async / broker

- `asyncio.Queue`、put/get、`create_task/gather/sleep`、`threading.Timer`、`schedule.every`。
- Celery task 和有 broker 证据的 publish/subscribe。
- receiver/import 必须匹配；route、ORM、dict、requests、其他库的 `.get/.put/.task/.publish` 不算 async protocol。
- 动态 pub/sub topic 会保留 declaration 并阻断，不生成确定性的假 topic。

### 4.5 Python 外部 HTTP

- 常见 `requests`、`httpx`、`urlopen`、`ClientSession` candidates。
- 支持静态 URL、按赋值顺序的变量绑定、环境变量、默认值、override 和重绑定。
- 同文件不同 env key 不会共享第一个配置身份；通用 `API_URL` 也保留 configured identity。
- 无法确定 identity 时生成 unknown candidate/omission；strict static-host gate 不会被 configured 默认值绕过。

### 4.6 明确未支持

- Django、RQ、任意动态 route registration 和完整 ASGI/WSGI dependency injection。
- 完整 ORM 类型系统、SSA、动态分派和运行时生成模型。
- 所有自定义 HTTP session/wrapper、所有 broker 和所有 Python 框架。
- 以上边界不能被“Python full 已通过”掩盖；相应输入必须失败关闭或保持明确 partial。

## 5. 固定版本验证证据

### 5.1 最新全量检查

在代码基线 `cad62c2` 上：

- `npm test`：**36 个测试文件、257 项测试通过**（在 e097293 上）。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run smoke:production`：通过；生产包中 Go/Python parser 可用，Python route 为 1 条、总 route 为 2 条、Python async operations 为 3 条。
- `git diff --check`：通过。

### 5.2 FastAPI 固定模板

- 仓库：`tiangolo/full-stack-fastapi-template`
- Revision：`aabb90126964a164e02aff39e7c385bb0598236d`
- Archive SHA-256：`57ab02195c0923dc3cd6ea91d671a3b1ee6b728d44219b7df8038abdc39d951c`
- Scope：`backend/**`

最终结果：

- 23/23 route declarations resolved，组合路径均为 `/api/v1/...`。
- 0/0 supported async declarations；该 backend 没有本切片支持的 asyncio/Celery 协议。
- 71 SQL operations：31 migration、15 read、13 write、12 transaction。
- 只有一个 `python:backend/app` runtime；无 import/engine 伪 operation，无 `requests.delete`/`router.delete` SQL 误报。
- `fullArchitecture: true`，仅表示该固定输入的语义门禁通过。
- 9 个页面自动 visual-check 全部 `pass`，代表性 light/dark 截图已人工查看；receipt 的 `visualReview` 按交付契约仍为 `pending`。

有效产物（Git 忽略）：

`/Users/leihan/Documents/GitHub/repomap/.repomap/validation/fastapi-m8-corrected11`

**不要使用旧的 `fastapi-m8-final-retry` 或 corrected1–10 统计作为当前证据。旧 `14/14 async` 含 route/ORM 误报，已经废弃。**

### 5.3 Click

- 仓库：`pallets/click`
- Revision：`8abb77a8432e03ed14a95f972b44f905279415a7`
- Archive SHA-256：`3220392c27a1a6590d4afe192f8c9b985add43544d5e63310b282c2e031c372b`

- 31 modules、440 import edges、440/440 independent declarations、2 cycles。
- 1 个动态 `__import__` omission。
- 固定版本没有 `__main__.py`；runtime/module 相关视图按证据失败关闭，不能为得到成功结果而隐藏 omission。

产物：`.repomap/validation/click-m8-final`

### 5.4 Black

- 仓库：`psf/black`
- Revision：`b4f1fcae48826790b6f93ca9226d20003bce0eaa`
- Archive SHA-256：`686f4696ae90b11dc1d80d51038b657b293ce449016af5a1f06609c229a3a1c7`

- 55 modules、376 import edges、0 unresolved imports、3 cycles。
- `src/black/__main__.py` 和 `src/blackd/__main__.py` 形成 CLI runtimes。
- 6 个 module 页面 accepted，自动 visual-check 通过，light/dark 截图已查看。

产物：`.repomap/validation/black-m8-final`

### 5.5 M6 既有回归

- Authelia：`32b0bdac395efc707bc098757afa232177965736`，97 页。
- WriteFreely：`8ff3647e9a094dbcf09c9c84d8e2305543ee5cfb`，31 页。
- Commerce：`f7521d57d29f0eb3d23c1399cf9bb299d61fcd21`，5 页。

产物目录：

- `/Users/leihan/Documents/GitHub/repomap-output/m6-final-v5-authelia`
- `/Users/leihan/Documents/GitHub/repomap-output/m6-final-v5-writefreely`
- `/Users/leihan/Documents/GitHub/repomap-output/m6-final-v5-commerce`

三者均为 fixed-SHA、accepted、`fullArchitecture: true`、round-trip 零缺失/重复/dangling，自动 visual-check 通过并抽查截图。这些结果同样是 per-input 证据，不是 Gold/release qualification。

## 6. 接手后先做什么

1. 阅读：
   - `docs/full-architecture-plan.md`
   - `docs/python-language-slice.md`
   - `docs/view-terminology.md`
   - `docs/gold-manifest.v1.json`
2. 检查 `git status`、`git log -3` 和当前 HEAD；不要假设本地 validation 目录已提交。
3. 跑第 7 节的基础检查，确认环境一致。
4. 新任务先写失败测试，尤其是负例、独立 declarations 和 omission；不要先降低门禁。
5. 每个独立切片单独提交，提交前跑全量测试、typecheck、build、production smoke、diff/secret 检查。
6. 若修改 Python 协议，重新运行固定 FastAPI backend，并人工核对 route paths、SQL actions/owners、async operations 和截图，不只看 receipt 状态。

## 7. 常用命令

```bash
cd /Users/leihan/Documents/GitHub/repomap
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:production
```

准备固定 Archify runtime（只生成忽略文件）：

```bash
npm run archify:prepare
```

重跑固定 FastAPI backend 的 no-render 语义检查：

```bash
REPOMAP_CACHE_DIR="$PWD/.repomap/cache" \
node dist/cli.js analyze \
  'tiangolo/full-stack-fastapi-template@aabb90126964a164e02aff39e7c385bb0598236d' \
  --include 'backend/**' \
  --out "$PWD/.repomap/validation/fastapi-m8-handoff" \
  --view full \
  --no-render
```

需要真实 HTML 和 visual-check 时：

```bash
REPOMAP_CACHE_DIR="$PWD/.repomap/cache" \
node dist/cli.js analyze \
  'tiangolo/full-stack-fastapi-template@aabb90126964a164e02aff39e7c385bb0598236d' \
  --include 'backend/**' \
  --out "$PWD/.repomap/validation/fastapi-m8-handoff-visual" \
  --view full \
  --visual-check
```

重点检查输出：

- `repomap.receipt.json`：requested views、delivery、coverage、fullArchitecture、visualReview。
- `architecture.route-graph.json`：真实 route path、handler、coverage、omissions。
- `architecture.async-graph.json`：operation action/topic、独立 denominator、coverage。
- `architecture.ir.json`：SQL/HTTP/async operations、owner、direction、evidence、omissions。
- `architecture.evidence.json`：完整 evidence 和引用关系。
- `architecture.views.json`：分页、projection、round-trip 和各页 delivery。

## 8. 下一步优先级

### P0：M7 评估与发布资格

- 为关键 facts 做 targeted human-reviewed Gold，不要求先维护整仓库人工 Gold。
- 分开报告 node/edge/direction/evidence 的 precision 和 recall。
- 固定 corpus、SHA/archive hash、false-positive/false-negative 清单和 failure matrix。
- 建立固定 CI 性能门槛、生产安装验证和 generator release qualification。
- 保持 per-input semantic full 与 release qualification 的术语分离。

### P1：Python 真实仓库与协议扩展

- 增加固定 SHA 的 Flask、SQLAlchemy/asyncio/Celery 真实仓库验证。
- 根据需求增加 Django/RQ；每个框架先写独立 declarations、负例和失败关闭测试。
- 扩展动态 ORM/SSA、HTTP wrapper 和 broker 时，不能复用“同名方法即协议”的捷径。

### P2：更多语言与可选 enrichment

- 按需求选择 Java/Kotlin、Rust 或 C#，重复 adapter、独立分母、真实仓库和生产安装流程。
- Harness/LLM 只能作为可选 enrichment，必须携带独立 evidence 并通过相同 coverage gates；确定性静态分析仍是默认路径。

## 9. 当前阻塞与注意事项

- 已完成的 Python 两个切片没有已知未提交实现或当前代码阻塞。
- **性能回归已定位并修复（4949b6e）**：CPU profile 定位到 view-manifest 的二次方 operation×edge 匹配、重复 evidence 数组合并、projections 数组重建，以及 sql-operations 对整个文件内容的反复 split/正则扫描；修复后语义产物字节级不变，perf:gate 通过（median 26395ms，阈值 60000ms；peak RSS 724MB）。median 仍约为 M1 基线 8s 的 3.3x——这是 M2–M8 真实新增分析（10739 operations、module graph、projection）的代价，阈值未改动。详见 `docs/performance-baseline.v1.json` 的 `gate` 段。
- **migration 语句欠报已修复（a231a69）**：根因是 `schemaMarkers` 与 `pythonSqlLineFilter` 都缺少 alembic DDL 助手（alter_column/create_index/drop_index/create_foreign_key/drop_constraint/create_primary_key）。修复后 fastapi-template 固定语料 62/62 与人工清点一致，fixture 测试 7/7，authelia 新增 69 条经人工抽查为真实 SQL 的迁移语句；gold 评估保持 59/59、0 FP，manifest 的 candidate 已移入 resolvedFindings。
- M7 未完成是后续资格评估工作，不影响已提交切片作为 per-input 能力使用。
- Click 和不受支持的动态 Python 输入失败关闭是预期行为，不要为了“全绿”删除 omission。
- GitHub anonymous API 可能限流；优先使用固定 SHA 和已有 archive cache，不在命令或日志中暴露 token。
- `docs/gold-manifest.v1.json` 仍是 pinned-not-audited skeleton，不是人工批准的 ground truth。
