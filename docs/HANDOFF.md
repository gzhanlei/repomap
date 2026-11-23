# RepoMap 接手文档

- 更新日期：2026-11-23
- 代码基线：`25169ff` 加上其后的 Flask `register_blueprint` 前缀覆盖修复与 Django ORM 切片提交（本地与 origin/main 一致：已含 SQLAlchemy/Celery/RQ/Django 真实语料批次、脚本式入口检测、函数内导入的路由作用域修复 433a30e、flask 接入 gold:report 25169ff。账本最新发布停在 #256 @ `e0af3f9`，其后的 push 未触发分析，见 §9）
- 远程仓库：`https://github.com/gzhanlei/repomap`
- 当前分支：`main`

> 本文描述当前可接手状态。早期 Radar、PPTCreator 和“尚未初始化/发布”的记录已过时，不再作为工作依据；需要追溯时查看 Git 历史。本文档提交位于上述代码基线之后。

## 1. 当前结论

RepoMap 是一个本地、确定性的架构分析 CLI。它从固定源码快照生成带证据的 Architecture IR、RouteGraph、ModuleGraph、SQL/Async operations、覆盖门禁和多视图 Archify 交付物。

已完成：

- M7 第一切片：targeted human-reviewed Gold 机制（`src/core/architecture/corpus-gold.ts`、`npm run gold:evaluate`）、fastapi-template 59 条人工审核 Gold（`docs/gold/fastapi-template.v1.json`）、click 21 条人工审核 Gold（`docs/gold/click.v1.json`，17 模块完整枚举 + 4 条 import 边；fact schema 已支持 module/import-edge/module scope）、固定性能门槛（`npm run perf:gate`）、CI workflow（`.github/workflows/ci.yml`：checks 与 performance-gate 均为阻塞）。
- M0–M6：scope、census、独立 declarations、Evidence Index、IR v2、TypeScript/Go 项目图、RouteGraph、统一 External、Target/Config、SQL/Async operations、逐视图门禁、独立 mutation 和多视图无损投影。
- M8 第一个 Python 切片：项目准备、Tree-sitter/WASM、src-layout、import/module graph、CLI 入口和 module 详图。
- M8 第二个 Python 切片：FastAPI/Flask routes、常见 DB-API/SQLAlchemy/Alembic operations、asyncio/queue/Celery/broker operations 和 Python 外部 HTTP candidates。
- codelphi 实战批次（1bc4068…ab0ec48，2026-11-13/16，已在 origin/main）：修复 TS handler 局部变量误判、flow 视图 TS 模块目标按路径解析、类型位置 `import()` 与 fetcher 注入封装的 blocking 误报、存储检测的标记表/引号内字面量误匹配，并新增游离操作流程投影（`detached:<路径>` owner），无运行时归属的操作也有流程页；codelphi@`d4a32ab` 五视图全过、交付 85 页。
- SQLAlchemy 2.0 切片（识别半在 0daeede，分类半 98664f2）：`session.scalars/stream/add_all` 进入 pythonSqlLineFilter，action 分类 scalars/stream=read、add_all=write（账本 Python SQL 操作 HP-6）。
- flow 视图 Python 目标解析回归修复（d05d0a5）：handler 调用目标 TS 记原始路径、Python 记 `module:<packageId>:<path>` 完整 ID，查找需双形式兜底；该回归由 `npm run gold:report` 的 fastapi analyzeExitCode 0→1 暴露——gold:report 必须每个切片都跑。
- Flask Blueprint 切片（8b476f0，2026-11-12）：python-routes.ts 新增 Blueprint `url_prefix` 组合与 `register_blueprint`，`add_url_rule` 端点间接引用失败关闭；审计修掉幻影声明（参数窗口按括号配平截断）与单一相对导入子模块的解析。flask 语料 `pallets/flask@49943b5a` 17/17 路由、两个完整枚举 scope 全中（接入 gold:report 见下）。
- SQLAlchemy 真实语料批次（2026-11-16/17）：新增 `sqlalchemy/sqlalchemy@fe8e67751891de18ba27171bbc8aa23b28bb8348` examples/** 人工审计 Gold（`docs/gold/sqlalchemy.v1.json`，66 条 facts：全部 session.scalars/stream/add_all 调用点逐行核验，含 sess 别名与 Session 接收器；targeted subset，暂无 precision scopes）。审计驱动了三个修复：caller marker 列表补齐三个会话方法（多行调用的被调行此前无 marker 命中）、sess 别名进入行过滤与 action 分类、驱动判定剥离非 URL 字符串字面量（"MySQL Crowbar" 曾抑制 examples/association 全部 caller 边）。已登记 gold-manifest。
- SQLAlchemy 语料第二轮（2026-11-17）：Python 入口检测新增脚本式入口信号（缩进 0 的 SQL 调用语句或 `asyncio.run(`，detector `python-script-entry`，无 main guard 也可成立），使 examples/asyncio、inheritance、generic_associations、graphs、nested_sets、dynamic_dict 等模块级脚本目录获得 runtime unit；alembic versions 目录因此成为独立 runtime unit，迁移操作 owner 从 python:app 变为 python:app/alembic/versions（符合"真实 op.* 调用保留 runtime owner"不变式，测试断言已按不变式更新）。召回 24/66 → 50/66、0 FP；四既有语料 gold:report 回归全绿。
- SQLAlchemy 语料第三轮（2026-11-17，收敛）：包级驱动归属——文件自身无驱动提及且单元驱动集合唯一时回退到 runtime unit 驱动集合（pythonDriverMatches 新增 unitDrivers 回退，storageCalls 一次计算单元文本）；`executableSqlEvidence` 接收者正则加 /i（dogpile_caching 的 `Session.` 大写接收器此前全部被过滤）。审计修正一处 gold 事实：performance/__init__.py:155 位于模块 docstring（1-210 行），是文档不是运行时调用，语料从 66 条修正为 65 条。**sqlalchemy 语料 65/65 通过、0 FP，已接入 `npm run gold:report`（sqlalchemy 的 analyze 门禁失败按 expectedGateFailure 登记：847 条阻断省略——117 条 lib 桶文件相对导入未解析、729 条库/测试代码外部调用 unknown-identity——库仓库的诚实 fail-closed）**。
- Celery 真实语料批次（2026-11-17）：新增 `celery/celery@9c2f238334331db43f15956f131235fd3bb70fd1` examples/** 人工审计 Gold（`docs/gold/celery.v1.json`，47 条 facts：全部 36 个 task 装饰器 consume + 11 条可静态识别的 .delay()/.apply_async() enqueue；3 个 canvas 表达式接收者按设计 fail-closed 为 dynamic enqueue + blocking unknown-identity omission，作为预期 omission 断言）。审计驱动了 celery enqueue 切片：`.delay()`/`.apply_async()` 此前完全未检测；新增 enqueue 操作（仓库级装饰任务名登记册让无 celery import 的 producer 文件也能归属；仓库级 constructed-app 接收器登记册绑定跨模块 `@app.task` 装饰器，如 `from .celery import app`、`from config import app`；非标识符接收者 fail-closed）。**celery 语料 47/47 一次通过、0 FP，已接入 gold:report——六语料 349/349 critical facts、0 FP、0 invalid evidence**。
- RQ 检测切片（2026-11-17，单测锁定）：analyzePythonAsync 新增 rq 支持——`importsRq` 绑定、enqueue 操作 topic 取第一参数（def/import 绑定验证的标识符或字符串字面量静态解析，形参引用与表达式 fail-closed + blocking omission）、`@job` 装饰器 consume（topic = 装饰函数名）。rq 绑定文件内任何 `.enqueue` 调用均为 enqueue（receiver 形态无关：q、self.q、传入 queue、链式构造）。
- census test-only 边界决策（2026-11-17，作者批准）：**异步提取器成为唯一允许消费 python test 文件的消费者**——extract.ts 把 census 中 test 角色的 python 文件（带 CRLF 规范化）作为 testFiles 传给 analyzePythonAsync；snapshot 组装与其他检测器/模块图完全不动（tests 依旧不进 snapshot）。实现要点：importsFor 支持括号多行 from-import；isArchitectureSourcePath 放行 python test 文件（其余语言的 test 路径仍排除）；**CRLF 陷阱**——numbered content 剥前缀后孤 `\r` 会被 tree-sitter 当行连接符，error-recovery 丢弃大半调用，必须 `\r\n? → \n` 规范化。
- rq 真实语料（2026-11-17，收敛）：`nvie/rq@5351724` 全仓库（rq/ + examples/ + tests/**）人工审计 Gold（`docs/gold/rq.v1.json`，488 条 facts = 20 个 @job 装饰器 consume + 468 条可静态判定的 .enqueue* 调用；113 条动态 enqueue（形参/表达式参数）按设计 fail-closed 为 blocking unknown-identity omission，作为预期 omission 断言）。**rq 语料 488/488 一次通过、0 FP，接入 gold:report——八语料 985/985 critical facts、0 FP、0 invalid evidence**，rq 的 analyze 门禁失败按 expectedGateFailure 登记。
- Django 路由切片（2026-11-17，收敛并接入报告）：python-routes.ts 新增 raw-scan Django 分析（无需 AST parser，声明在 parser-unavailable 模式下保留，与 flask 独立分母纪律一致）——`django.urls` 绑定、path()/re_path() 路由事实（framework "django"、method "PAGE"）、include 组合（字符串模块、模块对象变量 `include(uuid_urls)`、别名导入 `from hc.accounts import views as accounts_views` 均通过 def/class 索引与导入绑定解析；多前缀实例化——同一模块被多个前缀 include 时每实例产出路由集）、跨模块/类视图 handler（resolution re-export，sourcePath = 定义文件）、fail-closed（admin.site.urls 视图间接引用、动态前缀——healthchecks 的 SITE_ROOT 子路径部署、不可解析 include）。语料 `healthchecks/healthchecks@6c05a7ad`（149 个非 include 路由调用点人工对账：147 产出 + admin fail-closed omission + 动态前缀 omission）→ **django-healthchecks 语料 148/148 一次通过、0 FP，接入 gold:report——七语料 497/497 critical facts、0 FP、0 invalid evidence**。corpus-gold 的 route method 枚举补 "PAGE"（vite-react-router 先例已有该方法）。
- Flask 路由解析的作用域修复（2026-11-23）：router 组合解析此前只在模块级导入里找名字绑定，应用工厂里函数体内的 `from . import views` + `app.register_blueprint(views.bp)` 会退到"快照内唯一 `views.py` 文件名"兜底——flask 语料 `examples/**` 有三个 `views.py`，于是在 `examples/celery/src/task_app/__init__.py:25` 报出假的 `unresolved-import` 阻断 omission（路由本身由 Blueprint 声明产出、17/17 不丢，所以 gold 没暴露；现有单测只因夹具里只有一个 `views.py` 才通过）。修复：解析器为函数内导入记录所属函数的行范围（`PythonParsedImport.enclosingFunction`），`python-routes.ts` 新增 `importBindingAt` 按 Python 名字解析规则取绑定——函数内导入只在所属函数内且已执行到的行生效，否则取模块级导入；router 子引用、前缀常量和 `project.imports` 候选（按语句行号区分同名模块的重复导入）统一走它。同时去掉 `8b476f0` 为同一问题加的"唯一文件名"兜底（当时把函数内导入误判为"解析到包 `__init__`"）：名字没有导入绑定时按文件名猜与 §2"未知身份必须形成 omission"相悖，去掉后无绑定的引用失败关闭。flask 路由 omission 2→1（只剩设计内的 add_url_rule），其余八语料 236 个语义产物文件与修复前逐字节一致。
- flask 语料接入 `gold:report`（2026-11-23）：`pallets/flask@49943b5a` examples/** 的 17 条路由 Gold（两个完整枚举 scope：flaskr 12/12、celery task app 5/5）此前只登记在 manifest、从未进报告脚本——`8b476f0` 晚于建脚本的 `680fe76`，是漏接而非卡住；作用域修复后接入，**九语料 1002/1002 critical facts、0 FP、0 invalid evidence**，flask 的 analyze 门禁通过（退出码 0，无需 expectedGateFailure），唯一路由 omission 是设计内的 add_url_rule。
- Flask `register_blueprint` 前缀覆盖修复（2026-11-23）：`register_blueprint(bp, url_prefix=…)` 的注册前缀按 Flask 语义**替换**蓝图自身的 `url_prefix`，此前与 FastAPI 的 `include_router` 一样被拼接——自身前缀为 `/api` 的蓝图以 `url_prefix='/v2'` 注册会得到 `/v2/api/...`。依据是固定版本归档里的 Flask 源码（`src/flask/sansio/blueprints.py`：`url_prefix = options.get("url_prefix")`，仅为 None 时回退到蓝图自身；嵌套蓝图取父前缀 + 子蓝图的有效前缀）；显式 `url_prefix=''` 同样取消自身前缀。FastAPI `include_router` 逐层拼接的语义不变。flask 语料没有这种组合，九语料 260 个语义产物逐字节不变；行为由 4 个单测钉住（含 FastAPI 守卫），两个错误修法经变异验证都会被拦住。
- Django ORM 切片（2026-11-23）：管理器根的 ORM 语句 `Model.objects.<…>` 进入 SQL 操作，新提取器 `project/python-orm.ts`。模型登记册按类基类建立——`django.db.models.Model`、仓库内的模型子类（含传递继承）、Django 自带的 `AbstractUser/AbstractBaseUser/PermissionsMixin`；同样来自 Django 的 `forms.Form`、`BaseCommand`、`ModelAdmin` 等不算模型。根经导入绑定解析（别名、模块限定名、函数内导入），从 `django.*` 导入的类视为外部模型。链式调用一条语句一个操作，按终端方法分类：`create/update/delete/bulk_*` = write，`get/count/first/exists/iterator…` = read，`get_or_create/update_or_create` = read-write，以惰性查询构建方法结尾的语句记为 read。数据迁移里 `X = apps.get_model(...)` 绑定的名字视为历史模型（仅限迁移模块）。独立分母是原始扫描的 `<Model>.objects.<方法>(` 行（字符串字面量不算，小写属主如 `self.objects.get` 不算），解析器不可用时声明保留并阻断；根不是模型 → unknown-identity 阻断；未分类的管理器方法 → 操作保留 + uncertain-direction 阻断；声明找不到对应调用 → 阻断。只在导入了 Django 的项目里生效。**driver** 取快照里 `ENGINE: "django.db.backends.*"` 字面量归一后的引擎族：唯一为 static；单别名多引擎（按配置切换，如 healthchecks 的 `DB` 环境变量）为 `resolution: configured`、driver 写候选集合 `mysql|postgres|sqlite`、不阻断——**这一条作者未作答，按推荐方案实施，可以改**；多别名多引擎为 dynamic + unknown-identity 阻断；没有引擎字面量为 unknown + 阻断。操作 owner 归调用点所在的 runtime。healthchecks 上 161 条操作（迁移文件外 120 + 数据迁移内 41）与一份独立的 Python AST 枚举脚本按方法逐类吻合，owner 全部 `python:hc`，全仓库 SQL 操作由 5 条增至 166 条，另有 13 条自定义管理器方法（`for_user` 10、`for_api_key` 3）方向不确定阻断；celery 的 Django 示例多出 2 条（`Widget.objects.count/get`）；其余七语料逐字节不变。**这些数字是机器对账，不是人工审计的 Gold。**

尚未完成：

- M7 发布资格（未完成）：`npm run gold:report` 已覆盖九语料 1002/1002（见上），但 `docs/release-qualification.v1.json` 仍停在 `680fe76` 的四语料 237 条，需要在单一 HEAD 上重跑 `gold:report`、`perf:gate`、`smoke:production` 并全部退出 0 后重新汇总——本地 perf:gate 目前在本机不稳定（§9），2026-11-23 未重新汇总。批准块（decision/decidedBy/decidedAt）与 FastAPI 视觉独立确认留给作者，receipt `visualReview` 仍为 `pending`。writefreely 与 commerce 两个语料仍是 pinned-not-audited。
- Django ORM 的其余形态：实例方法（`obj.save()`/`delete()`）、查询集与关联管理器变量上的调用（`qs.count()`、`project.check_set.all()`）需要作用域内的绑定分析，不在当前分母里；自定义管理器方法的方向（目前保留操作并阻断）；非 Django 的第三方模型基类（阻断）；Django 模式迁移（`migrations.CreateModel/AddField/AlterField…`，healthchecks 约 250 处，尚不产生 migration 操作）。此外还有完整动态依赖注入/ORM/SSA，以及更多语言和真实仓库审查。
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
| `src/core/architecture/project/python-routes.ts` | FastAPI/Flask routes、APIRouter/Blueprint composition（`importBindingAt` 按作用域取导入绑定）、Django urls.py routes、独立 route declarations |
| `src/core/architecture/project/python-async.ts` | asyncio/Celery/rq/broker operations（含 test 角色的 python 文件）和独立 async declarations |
| `src/core/architecture/project/python-orm.ts` | Django ORM 管理器调用 → SQL operations（模型登记册、根解析、终端方法分类、ENGINE 驱动）和独立 orm declarations |
| `src/core/architecture/detectors/python.ts` | Python runtime entrypoints 和最近入口 ownership |
| `src/core/architecture/detectors/storage.ts` | store 信号、driver-aware SQL evidence 和 runtime/store 关系 |
| `src/core/architecture/sql-operations.ts` | 可执行 SQL operation 分类、ownership 和 driver 歧义 omissions |
| `src/core/architecture/detectors/generic-external.ts` | 通用外部协议候选及 Python HTTP call-site identity |
| `tests/python-protocols.test.ts` | Python 第二切片正负例、失败关闭和 independence fixtures |
| `scripts/production-smoke.mjs` | 打包后生产安装与 TypeScript/Go/Python smoke |
| `scripts/gold-report.ts` | 九语料 gold 汇总报告（`npm run gold:report`，重新生成 `docs/gold-evaluation-report.v1.json`） |
| `scripts/performance-gate.ts` | 固定 Authelia 语料的耗时/峰值 RSS 门禁（`npm run perf:gate`） |

## 4. 当前 Python 能力边界

### 4.1 项目与 ModuleGraph

- 固定 `tree-sitter-python@0.25.0`、`web-tree-sitter@0.27.2`，与 Go 共享一次进程级 Tree-sitter 初始化，但 parser 实例隔离。
- 不执行仓库 Python，不读取宿主 Python、virtualenv 或 installed packages。
- 支持 src layout、package、`__init__.py`、`__main__.py`、main guard、绝对/相对 import、嵌套/future import。
- 支持字面量 `importlib.import_module`、`__import__`、aliases、re-export、wildcard export 和静态 `__all__`。
- 动态 import、workspace 歧义、relative escape、unsupported `__all__` 和 parser-unavailable 均失败关闭。
- 无 main guard 的脚本式入口也算 runtime 入口：缩进 0 的 SQL 调用语句或 `asyncio.run(`（detector `python-script-entry`）。

### 4.2 FastAPI/Flask/Django routes

- decorator route、多个 HTTP methods、本地 handler 和 direct calls。
- 跨文件 `APIRouter` 组合，包括静态 prefix 和 `settings.API_V1_STR` 这类模块常量。
- route declarations 按 receiver 独立识别 FastAPI/Flask；普通 `@registry.get` 不进入 route 分母。
- 动态 path/method、循环或歧义 prefix、unresolved include/factory 会产生 omission。
- 普通对象的 `include_router` 不会被误判为 FastAPI，也不会无故阻断全图。
- Flask Blueprint：`Blueprint(url_prefix=…)` 自身前缀与 `register_blueprint` 组合；蓝图模块名按作用域绑定导入（`importBindingAt`：函数内导入只在所属函数内且已执行的行生效，否则取模块级导入），没有导入绑定的引用失败关闭、不按文件名猜；`add_url_rule` 端点间接引用失败关闭。
- Django `urls.py`：`path()`/`re_path()` 路由（framework `django`、method `PAGE`）、`include()` 组合（字符串模块、模块对象变量、别名导入；同一模块被多个前缀 include 时每实例一套路由）、跨模块与类视图 handler；`admin.site.urls` 这类视图间接引用和动态前缀（如 SITE_ROOT 子路径部署）失败关闭。
- Flask 注册前缀：`register_blueprint(bp, url_prefix=…)` 的 `url_prefix` 替换蓝图自身前缀（显式空串同样取消）；嵌套蓝图的最终前缀 = 父蓝图前缀 + 子蓝图的有效前缀。FastAPI `include_router(router, prefix=…)` 则是逐层拼接：父路由器前缀 + include 前缀 + 子路由器自身前缀。

### 4.3 SQL / Alembic

- 常见 DB-API、SQLAlchemy/SQLModel read/write/transaction/migration operations。
- 支持 `session.get/exec/query` 和多行 SQL 上下文分类。
- SQLAlchemy 2.0 会话方法：`session.scalars/stream` 归 read、`add_all` 归 write；独立调用行、`sess` 别名和大写 `Session` 接收器都能识别。
- 文件自身没有驱动提及、而所属 runtime unit 的驱动集合唯一时，SQL 证据回退到单元驱动集合（包级 `create_engine`）。
- Django ORM 的管理器根语句 `Model.objects.<…>`：模型按类基类登记、根经导入绑定解析；一条语句一个操作，按终端方法分类，惰性查询构建记为 read；数据迁移里 `apps.get_model(...)` 绑定的名字视为历史模型。
- ORM 调用的 driver 取自 Django `DATABASES` 的 ENGINE 字面量：引擎唯一为 static；单别名多引擎为 configured（driver 写候选集合，不阻断）；多别名多引擎或没有引擎字面量时阻断。
- 只在导入了 Django 的项目中生效；`Model.objects` 之外的 ORM 形态不进入分母（见 §4.6）。
- ORM 操作目前只进入 IR 和流程视图，不产生 runtime → store 的 facts 边。纯 ORM 的 Django 项目里，由引擎字面量检出的 store 节点在 runtime overview 中不可达，整体交付因 coverage 不可发布而失败——这是既有行为，在 ORM 切片之前的同一份代码上结果相同。
- import、schema 声明和 `create_engine` 只支撑 store/schema coverage，不生成伪造的 runtime operation。
- Alembic `op.*` 调用归执行它的 runtime；纯 schema resource 可归 store。
- 多数据库下，driver-neutral 或 driver 歧义调用不会扇出到多个 store，而是生成阻断 omission。
- object-store 不参与 SQL database 数量判断。

### 4.4 Async / broker

- `asyncio.Queue`、put/get、`create_task/gather/sleep`、`threading.Timer`、`schedule.every`。
- Celery task 和有 broker 证据的 publish/subscribe。
- Celery `.delay()`/`.apply_async()` enqueue：仓库级装饰任务登记册让没有 celery import 的 producer 文件也能归属，跨模块 `@app.task` 经仓库级 constructed-app 接收器绑定；canvas 表达式等非标识符接收者失败关闭。
- rq：`@job` 装饰器 consume（topic = 被装饰函数名）；绑定了 rq 的文件里任何 `.enqueue` 调用都是 enqueue，topic 取第一参数——def/import 绑定的标识符或字符串字面量静态解析，形参与表达式失败关闭。
- census 里 test 角色的 python 文件只供异步提取器消费（CRLF 规范化后传入）；它们仍不进 snapshot，其他语言的 test 路径和其余检测器不变。
- receiver/import 必须匹配；route、ORM、dict、requests、其他库的 `.get/.put/.task/.publish` 不算 async protocol。
- 动态 pub/sub topic 会保留 declaration 并阻断，不生成确定性的假 topic。

### 4.5 Python 外部 HTTP

- 常见 `requests`、`httpx`、`urlopen`、`ClientSession` candidates。
- 支持静态 URL、按赋值顺序的变量绑定、环境变量、默认值、override 和重绑定。
- 同文件不同 env key 不会共享第一个配置身份；通用 `API_URL` 也保留 configured identity。
- 无法确定 identity 时生成 unknown candidate/omission；strict static-host gate 不会被 configured 默认值绕过。

### 4.6 明确未支持

- Django 在 `urls.py` 路由和管理器根 ORM 语句之外的能力：实例方法（`obj.save()`/`delete()`/`refresh_from_db()`）、查询集与关联管理器变量上的调用（`qs.count()`、`project.check_set.all()`）、自定义管理器/QuerySet 方法的方向（保留操作并阻断）、非 Django 的第三方模型基类（阻断）、Django 模式迁移（`migrations.CreateModel/AddField/…` 尚不产生 migration 操作），以及 `admin.site.urls` 这类视图间接引用；rq 的动态 job 参数；任意动态 route registration 和完整 ASGI/WSGI dependency injection。
- 完整 ORM 类型系统、SSA、动态分派和运行时生成模型。
- 所有自定义 HTTP session/wrapper、所有 broker 和所有 Python 框架。
- 以上边界不能被“Python full 已通过”掩盖；相应输入必须失败关闭或保持明确 partial。

## 5. 固定版本验证证据

### 5.1 最新全量检查

在代码基线 `25169ff` 加上 Flask 前缀覆盖修复与 Django ORM 切片上（2026-11-23，darwin arm64，node v25.5.0）：

- `npm test`：**37 个测试文件、309 项测试通过**。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run smoke:production`：通过；生产包中 Go/Python parser 可用，Python route 为 1 条、总 route 为 2 条、Python async operations 为 3 条。
- `git diff --check`：通过。
- `npm run gold:report`：九语料 1002/1002 critical facts、0 FP、0 invalid evidence，退出码 0。
- CI（`25169ff`，ubuntu-latest / node 22，run 45170737995）：checks 与 performance-gate 均通过；performance-gate 三次峰值 RSS 为 791,732,224 / 880,791,552 / 880,959,488 字节，中位耗时 21,784ms。
- 本地 `npm run perf:gate` 在同一基线上退出码 1（仅 peakRss 一项不过：1,076,822,016 / 1,110,867,968 / 950,288,384 字节，中位 21,185ms）——这是本机当日噪声，见 §9，阈值未改动。

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

### 5.6 Python 真实语料 Gold

五个 Python 真实仓库语料均由 `npm run gold:report` 在固定 SHA 上重跑，逐语料明细见 `docs/gold-evaluation-report.v1.json`，审计过程见 §1：

| 语料 | 范围 | 人工审计 Gold | analyze 门禁 |
| --- | --- | --- | --- |
| `pallets/flask@49943b5a94413a530761350f04e896f76e8d620e` | `examples/**` | 17 条路由；两个完整枚举 scope（flaskr 12/12、celery task app 5/5） | 通过（退出码 0）；唯一路由 omission 是设计内的 add_url_rule |
| `sqlalchemy/sqlalchemy@fe8e67751891de18ba27171bbc8aa23b28bb8348` | `examples/**` | 65 条 SQL 操作（scalars/stream/add_all 逐行核验） | 预期失败：847 条库/测试代码的阻断省略 |
| `celery/celery@9c2f238334331db43f15956f131235fd3bb70fd1` | `examples/**` | 47 条（36 个 task 装饰器 consume + 11 条 enqueue） | 预期失败：库/测试代码阻断省略 |
| `healthchecks/healthchecks@6c05a7adf266efb70f9517727bef9ea8b2bbf52f` | 全仓库 | 148 条 Django 路由 | 预期失败：SITE_ROOT 动态前缀与 admin.site.urls |
| `nvie/rq@535172412469b78d4ac690a446284d8ec1e9f541` | `rq/`、`examples/`、`tests/**` | 488 条（20 个 `@job` consume + 468 条静态 enqueue） | 预期失败：113 条动态 enqueue |

“预期失败”指语料的 analyze 退出码非 0，但失败的是按设计失败关闭的库/测试代码；gold 评估只看对应的语义产物，omission 不计入覆盖。另外四个语料见 §5.2（fastapi-template）、§5.3（click）、§5.4（black）、§5.5（authelia）。

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
npm run gold:report
npm run perf:gate
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

现状（2026-11-23）：九语料 1002/1002 已进 `gold:report`，CI 性能门槛（阻塞）与生产安装验证都在 CI 内。剩余是 release qualification 的作者收尾：`docs/release-qualification.v1.json` 仍停在 `680fe76` 的四语料 237 条，重新汇总要求 `gold:report`、`perf:gate`、`smoke:production` 在单一 HEAD 上全部退出 0——本地 perf:gate 目前在本机不稳定（§9），能否以 CI 的 performance-gate 运行作为性能证据由作者决定。另有待定：CI 是否跑完整 `gold:report`（现在只守 fastapi-template 一个语料，其余八个靠本地自觉）。

- 为关键 facts 做 targeted human-reviewed Gold，不要求先维护整仓库人工 Gold。
- 分开报告 node/edge/direction/evidence 的 precision 和 recall。
- 固定 corpus、SHA/archive hash、false-positive/false-negative 清单和 failure matrix。
- 建立固定 CI 性能门槛、生产安装验证和 generator release qualification。
- 保持 per-input semantic full 与 release qualification 的术语分离。

### P1：Python 真实仓库与协议扩展

- 已有固定 SHA 真实语料：Flask、SQLAlchemy、Celery、Django（urls.py 路由）、RQ（§5.6）；asyncio 还没有人工审计语料。
- 下一个候选切片（Django）：模式迁移 → migration 操作（`migrations.CreateModel/AddField/AlterField…`，healthchecks 约 250 处，标记明确、可原始扫描）；ORM 的实例方法与查询集变量调用（需要作用域内的绑定分析）；自定义管理器方法的方向。Django ORM 的人工审计 Gold 还没有做——现有 161 条只是与独立脚本的机器对账。
- 每个新框架或协议先写独立 declarations、负例和失败关闭测试。
- 扩展动态 ORM/SSA、HTTP wrapper 和 broker 时，不能复用“同名方法即协议”的捷径。

### P2：更多语言与可选 enrichment

- 按需求选择 Java/Kotlin、Rust 或 C#，重复 adapter、独立分母、真实仓库和生产安装流程。
- Harness/LLM 只能作为可选 enrichment，必须携带独立 evidence 并通过相同 coverage gates；确定性静态分析仍是默认路径。

## 9. 当前阻塞与注意事项

- 已完成的 Python 两个切片没有已知未提交实现或当前代码阻塞。
- **性能回归已定位并修复（4949b6e）**：CPU profile 定位到 view-manifest 的二次方 operation×edge 匹配、重复 evidence 数组合并、projections 数组重建，以及 sql-operations 对整个文件内容的反复 split/正则扫描；修复后语义产物字节级不变。median 仍约为 M1 基线 8s 的 3x——这是 M2–M8 真实新增分析（10739 operations、module graph、projection）的代价，阈值未改动。
- **CI peak RSS 超阈值已解决（d766850）**：调查定位两个根因（node 22 比 node 25 多占 100–150MB 堆；Linux/GitHub runner 内存口径再加 300MB+），gate 改为在固定 1GiB V8 老生代上限（`--max-old-space-size=1024`）下测量——node 默认老生代随宿主内存浮动，固定堆才是可复现口径；产物字节级一致（node 25/22 × darwin/linux 全验证），`MALLOC_ARENA_MAX=1` 实测更差已否决。受控堆后 CI 全绿：median 29.2s、peak RSS 916–960MB（阈值内）。CI 的 performance-gate job 已于 2026-11-12 经人工批准转为阻塞（受控堆下 ubuntu 通过，余量 ~114MB）。详见 `docs/performance-baseline.v1.json` 的 `gate.investigation` / `gate.ciMeasurements`。
- **migration 语句欠报已修复（a231a69，见 resolvedFindings）**：根因是 `schemaMarkers` 与 `pythonSqlLineFilter` 都缺少 alembic DDL 助手（alter_column/create_index/drop_index/create_foreign_key/drop_constraint/create_primary_key）。修复后 fastapi-template 固定语料 62/62 与人工清点一致，fixture 测试 7/7，authelia 新增 69 条经人工抽查为真实 SQL 的迁移语句；gold 评估保持 59/59、0 FP，manifest 的 candidate 已移入 resolvedFindings。
- M7 未完成是后续资格评估工作，不影响已提交切片作为 per-input 能力使用。
- Click 和不受支持的动态 Python 输入失败关闭是预期行为，不要为了“全绿”删除 omission。
- GitHub anonymous API 可能限流；优先使用固定 SHA 和已有 archive cache，不在命令或日志中暴露 token。
- `docs/gold-manifest.v1.json` 现含九个 human-audited-targeted 语料，全部接入 `gold:report`；writefreely 与 commerce 仍是 pinned-not-audited。sqlalchemy、celery、django-healthchecks、rq 四个条目尚未登记 archiveSha256（其余七个都有）。
- **本地 perf gate 噪声（2026-11-23）**：同一份代码在本机的 6 次峰值 RSS——`680fe76` 为 751,550,464–1,132,445,696 字节（3/6 超阈值）、`401b50b` 为 958,038,016–1,102,495,744（5/6 超阈值）、`f949b59` 3 次为 939,638,784–1,069,236,224、`25169ff` 3 次为 950,288,384–1,110,867,968（退出码 1）；文档记录的本地基线是 916,619,264；同期 CI 三次运行的最大值分别为 945,750,016（`f949b59`）、891,551,744（`433a30e`）、880,959,488 字节（`25169ff`）。当日本机 swap 已用 14.1/15.4GB、负载约 5，原因未验证（推测是内存压力改变了 GC 时序）。阈值未改动。本地 perf:gate 失败时不要归因于切片：先对基线提交做临时 worktree 的 A/B（各 ≥6 次、比较范围），以 CI 的 performance-gate（ubuntu/node 22）为准。
- **Django ORM 的数字是机器对账**（2026-11-23）：healthchecks 的 161 条 ORM 操作与一份独立的 Python AST 枚举脚本按方法逐类吻合，但没有经过人工审计，不是 Gold；gold-manifest 里没有对应的 sql-operation facts。单别名多引擎按 `configured` 身份处理、不阻断，是在作者未作答时按推荐方案实施的，可改。
- **账本对账积压（2026-11-23）**：codelphi 账本的最新分析与发布停在 run 371 / #256 @ `e0af3f9`；其后的 push（`401b50b`、`f949b59`、`433a30e`、`25169ff`）都没有触发分析（`wait_for_release` 返回 `analysisRunId: null`），需要在 codelphi 侧检查 webhook/摄取；恢复后对这段区间的发布做意图对账。
