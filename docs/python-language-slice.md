# Python 语言覆盖第一阶段（M8）

## 当前边界

本阶段提供 **Python 项目准备、源码模块图、CLI 入口和 module 详图**，并有独立的 FastAPI/Flask route、常见 DB-API/SQLAlchemy/Alembic、asyncio/queue/Celery 协议切片；不宣称完整支持所有 Python 应用架构。

已支持：

- 固定 `tree-sitter-python@0.25.0` + `web-tree-sitter@0.27.2` WASM 解析；
- 原始文本快照，不执行 Python、虚拟环境、安装包或仓库代码；
- `src` layout、普通 package、`__init__.py`、`__main__.py` 和 main guard；
- 绝对/相对 import、`importlib.import_module` 与 `__import__` 的字面量目标；
- 函数、`try`、`if` 等块中的 import，以及 `from __future__ import ...`；
- 独立 import 行扫描、三引号 docstring 排除、循环依赖、AST evidence 和 parser-unavailable 降级；
- 复用 `architecture.module-graph.json`、IR、Evidence Index 和 module 分页详图。

明确未支持：

- Django、Starlette 之外的动态路由注册和完整依赖注入；
- 完整 ORM 类型/SSA、动态分派和运行时生成模型；
- 除常见 DB-API/SQLAlchemy/Alembic 之外的存储驱动；
- 除 asyncio/queue/Celery 之外的异步框架。

## 第二阶段：route、SQL 与 async

已接入：

- FastAPI/Flask decorator 路由、方法列表、APIRouter 前缀和本地 handler；
- DB-API、SQLAlchemy 的 read/write/transaction/migration operation；
- Alembic migration 文件与 store evidence 归属；
- asyncio Queue、生产/消费、create_task/gather、sleep、threading.Timer、schedule.every 和 Celery task operation；
- 统一 Python HTTP/GraphQL candidate、静态 host、环境配置和 unknown omission。

`tiangolo/full-stack-fastapi-template@aabb90126964a164e02aff39e7c385bb0598236d` 的 `backend/**` 已验证：

- 23/23 route declarations resolved，跨文件组合后的路径均为 `/api/v1/...`；
- 0/0 supported async declarations（该固定 backend 没有支持的 asyncio/Celery 协议，不能把路由 `.get()` 或 ORM `.get()` 计入 async）；
- 71 条 SQL operation（31 migration、15 read、13 write、12 transaction），无 `requests.delete`/`router.delete` 误报；
- 仅保留一个 `python:backend/app` runtime，`APIRouter` 不再被当作 deployable；
- `fullArchitecture: true`（仅表示该输入在声明范围内的语义门禁通过）；
- 9 个页面自动 Archify/visual-check 全部 `pass`，代表性浅色/深色截图已人工查看；receipt 的 `visualReview` 仍按契约为 `pending`，直到独立人工确认流程完成。

产物（Git 忽略）：`/Users/leihan/Documents/GitHub/repomap/.repomap/validation/fastapi-m8-corrected11`。

支持的 Python 切片可以通过 `full`；Django、RQ、动态依赖注入/动态 ORM、无法解析的 router 或 URL 仍失败关闭。`fullArchitecture: true` 不是普遍 Python 支持或 generator release qualification。

## 固定版本验证

### `pallets/click`

Revision: `8abb77a8432e03ed14a95f972b44f905279415a7`  
Archive SHA-256: `3220392c27a1a6590d4afe192f8c9b985add43544d5e63310b282c2e031c372b`

- 31 个 source modules、440 条 import edges；
- 440/440 independent import declarations observed；
- 1 个动态 `__import__` omission（`complex.commands.cmd_` 前缀不是可静态确定的完整模块），2 cycles；
- 该版本没有 `__main__.py`，因此 CLI/runtime 发布按预期失败；动态 omission 也阻断 module 视图，不能用模块图完整性冒充协议完整性。

输出（Git 忽略）：`/Users/leihan/Documents/GitHub/repomap/.repomap/validation/click-m8-final`

### `psf/black`

Revision: `b4f1fcae48826790b6f93ca9226d20003bce0eaa`  
Archive SHA-256: `686f4696ae90b11dc1d80d51038b657b293ce449016af5a1f06609c229a3a1c7`

- 55 个 source modules、376 条 import edges；
- 0 unresolved imports、3 cycles；
- `src/black/__main__.py` 与 `src/blackd/__main__.py` 均形成 CLI runtime；
- module 请求为 `facts-ready`；
- 6 个 module 页面全部 `accepted`，Archify validation 和自动 visual-check 全部通过，浅色/深色截图已人工查看。

输出（Git 忽略）：

- facts/receipt：`/Users/leihan/Documents/GitHub/repomap/.repomap/validation/black-m8-final`
- 实际 HTML/截图：`/Users/leihan/Documents/GitHub/repomap/.repomap/validation/black-m8-final`

## 解析器初始化

Go 和 Python grammar 共享一个进程级 `initializeTreeSitter()` Promise。每个语言仍有独立 parser 实例，避免多模块初始化顺序导致空语法树或语言串扰。测试覆盖 Go 状态调用后解析 Python，以及 Click 的完整项目准备路径。

## 后续切片

1. Django/RQ 与更多 ASGI/WSGI 组合方式；
2. 更完整的 ORM/SSA、动态分派和外部 HTTP call-site 归属；
3. 更多固定 SHA 的真实仓库、人工 critical-fact review 与语言/框架负例。
