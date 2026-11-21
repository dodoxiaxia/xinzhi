# 本地测试说明

本说明针对 `scripts/run_all_tests.sh`。测试与离线夹具不需要仓库的 `state` 分支、线上服务、密钥或模型调用。

## 首次准备

在仓库根目录运行：

```sh
python3 -m pip install -r requirements-ci.txt
python3 -m pip install playwright
python3 -m playwright install chromium
npm install --global playwright
export NODE_PATH="$(npm root -g)"
bash scripts/run_all_tests.sh
```

`requirements-ci.txt` 提供仓库 CI 所需的 Python 依赖（包括 PyMuPDF）。Python 与 Node 两端的 Playwright 包都要安装，Chromium 可用系统安装，也可由 Python Playwright 安装。runner 会依次查找 `$CHROMIUM_PATH`、`/usr/bin/chromium`、`/usr/bin/chromium-browser`、`/usr/bin/google-chrome`、Python Playwright 自带浏览器、Node Playwright 自带浏览器，并把选中的路径导出给子进程。无效的 `$CHROMIUM_PATH` 会继续回退查找。可用下面的命令只查看检测结果：

```sh
bash scripts/run_all_tests.sh --print-env
```

## 运行方式

```sh
bash scripts/run_all_tests.sh                 # 默认：浏览器测试使用当前源码的隔离构建
bash scripts/run_all_tests.sh --fixture       # 在全新隔离源码副本中构建并运行
bash scripts/run_all_tests.sh --no-fixture    # 禁止自动生成，现有 data/、public/ 原样使用
bash scripts/run_all_tests.sh --no-browser    # 运行非浏览器测试，浏览器项目逐项显示 SKIP 原因
```

默认模式启用浏览器测试时，总是在隔离的当前源码副本中构建 `public/` 并在那里运行测试，避免使用切换分支后留下的旧公开产物。若原工作树已有 `data/`，runner 只复制其中的常规文件到隔离副本，不合成夹具、不补齐或修复部分数据；随后离线运行 `build_public.py`。原工作树的 `data/`、`public/` 和 `docs/` 保持不变。数据目录或其内容含符号链接、FIFO 等非常规文件时，准备步骤会报错并停止，不会回退到原 `public/` 运行测试。

若原工作树没有 `data/`，默认模式仍在隔离副本中生成离线夹具；为兼容现有行为，只把忽略的 `data/` 和缺失的 `public/` 发布回原工作树。若原工作树已有 `public/`，不会覆盖它；浏览器测试仍在隔离副本中运行，因此不会读到该旧产物。夹具和公开构建产生的 `docs/public-manifest.json` 等跟踪文件不会写回原工作树。

`--no-browser` 保留默认旧行为以避免无浏览器检查时额外构建：已有 `data/` 按原样使用，缺少 `data/` 时生成离线夹具；浏览器条目逐项跳过。`--no-fixture` 则始终不生成或重建 `data/`、`public/`，并按原样使用已有文件；在该模式中，若刚切换源码分支且需要浏览器测试，请先为当前分支运行 `python3 scripts/build_public.py`。

`--fixture` 不读取或修改原工作树中的 `data/`、`public/`、`.local/`、密钥文件或符号链接；它在新的源码副本中生成夹具、构建公开输出并在那里运行测试。夹具使用仓库内已提交的测试输入，不调用网络或模型；生成/构建进程带有 Python socket 与 Node 网络 API 拒绝守卫。该模式的日志保存在 `$HOME/xinzhi-test-logs/`，不随临时工作副本清理。`--fixture` 与 `--no-fixture` 不能同时使用。

`--no-fixture` 不会生成 `data/` 或 `public/`。浏览器项目需要 `public/` 时，若目录不存在会在启动命令前显示相应 `SKIP`；命令一旦启动后失败，仍计为 `FAIL`。`--no-browser` 同样只跳过浏览器部分，仍执行 smoke 测试中不需要浏览器的断言和其他非浏览器测试。

## SKIP 的含义

- `Python playwright package not installed`：Python Playwright 不可导入；对应 Python 浏览器脚本未启动。
- `Node playwright package not installed`：Node Playwright 在当前 `NODE_PATH` 下不可解析；对应 Node 浏览器脚本未启动。其他 Node 测试仍执行。
- `Chrome/Chromium executable not found`：显式路径、系统候选和两端 Playwright 自带浏览器均不可执行；浏览器脚本未启动。
- `public/ not built ...`：测试需要静态公开构建，但未生成或找不到 `public/`；脚本未启动。
- `--no-browser requested`：用户显式关闭浏览器测试。
- `PyMuPDF (fitz) package not installed`、`workerd executable not available`：对应可选依赖不可用。

常规日志位于 `.local/test-logs/`；`--fixture` 日志位于 `$HOME/xinzhi-test-logs/`。总结格式为：

```text
== Summary: <通过数> passed, 0 failed, <跳过数> skipped
```

在 Python/Node Playwright、Chrome/Chromium 与夹具构建均可用的环境中，浏览器测试和首屏预算必须实际运行，不应因缺少 `public/` 被跳过。可选 `workerd` 等依赖仍可能产生带原因的单项 `SKIP`。`--no-browser` 下的浏览器 `SKIP` 是预期结果；检查日志时仍需确认所有已启动命令的失败被保留为 `FAIL`。
