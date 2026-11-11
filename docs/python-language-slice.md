# Python 语言覆盖第一阶段（M8）

## 当前边界

本阶段提供 **Python 项目准备、源码模块图、CLI 入口和 module 详图**，不宣称完整支持 Python 应用架构。

已支持：

- 固定 `tree-sitter-python@0.25.0` + `web-tree-sitter@0.27.2` WASM 解析；
- 原始文本快照，不执行 Python、虚拟环境、安装包或仓库代码；
- `src` layout、普通 package、`__init__.py`、`__main__.py` 和 main guard；
- 绝对/相对 import、`importlib.import_module` 与 `__import__` 的字面量目标；
- 函数、`try`、`if` 等块中的 import，以及 `from __future__ import ...`；
- 独立 import 行扫描、三引号 docstring 排除、循环依赖、AST evidence 和 parser-unavailable 降级；
- 复用 `architecture.module-graph.json`、IR、Evidence Index 和 module 分页详图。

明确未支持：

- FastAPI、Flask、Django 等框架 route/handler 图；
- SQLAlchemy/ORM、数据库事务和迁移归属；
- Celery、RQ、asyncio task、channel 和定时任务 operation；
- 动态装饰器、运行时依赖注入、完整类型/SSA/动态分派。

因此 Python 的 `full` 请求仍应失败关闭。`fullArchitecture: false` 是预期结果，不用模块图完整性冒充协议完整性。

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

1. Python route/decorator 与 ASGI/WSGI handler 图；
2. SQL/ORM 与外部 HTTP operation；
3. asyncio/Celery/RQ 等异步 operation；
4. 更多固定 SHA 的真实仓库与语言/框架负例。
