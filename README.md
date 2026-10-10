# xterm — SSH / Telnet / 串口 多标签连接工具

> 文档现状索引：[`docs/STATUS.md`](docs/STATUS.md)（最后更新 2026-09-11）。功能对标见 [`docs/FEATURE-PLAN.md`](docs/FEATURE-PLAN.md)；模块结构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

轻量、快速的连接工具:点选即连,多标签同时管理 SSH / Telnet / 串口会话。
浏览器界面(xterm.js 渲染,与 VSCode 终端同款),本地 Node 服务承载连接。

## 快速开始

### 下载源码后直接双击（Windows）

下载仓库 ZIP，完整解压后双击 **`启动.cmd`** 或 **`launcher.vbs`**。不需要手动安装 Node.js、运行 npm 命令、安装编译器或配置环境变量。首次启动会显示准备进度，自动下载校验过的 Node.js、应用依赖和 Electron；准备完成后打开应用窗口，命令窗口自动关闭。首次准备需要联网，之后使用本地缓存启动。

支持 Windows 10 1809 及以上和 Windows 11 的 x64/ARM64 电脑；源码目录可以含中文、空格和 `&`。运行时保存在仓库的 `.runtime` 目录，不修改系统 Node 或全局 npm 配置。首次无法联网时可使用下面的完整离线便携包；其他系统使用各自的入口和运行环境。

### 换电脑使用：离线便携包

Windows 用户优先使用 `dist/xterm-win32-x64-portable-*.zip`：**解压整个 ZIP，打开其中的文件夹，双击 `launcher.vbs`**。也可双击 `run.bat` 查看诊断信息。便携包包含 Node.js、Electron、界面资源和对应平台的原生串口/本机终端组件，不需要管理员权限、预装 Node.js 或首次联网下载。必须一起保留 `runtime`、`node_modules`、`desktop`、`server` 和 `web` 等目录；不要只复制一个启动脚本。

当前 Windows x64 便携包面向 Windows 10 1809 及以后版本、Windows 11。其他操作系统或 CPU 架构必须分别构建匹配的包，不能把 Windows 原生模块复制到 macOS/Linux 使用；系统权限、设备驱动和安全策略仍由目标电脑管理。

在安装完整依赖的目标平台上构建：

```sh
npm run build:portable
# Windows x64：验证实际 ZIP 的解压、离线启动、无系统 Node 和原生组件
npm run test:portable
```

构建时会验证实际组件和原生模块，生成 ZIP 及保留解压目录。运行时优先使用包内 Node，检测平台和 Node ABI；便携包损坏时提示重新完整解压，不会尝试联网安装。

### 首次运行

Windows 源码首次运行可双击 `启动.cmd` 或 `launcher.vbs`。启动器会自动准备 Node.js，检查依赖入口、Electron 可执行文件以及原生模块是否能加载，自动修复残缺依赖，然后打开 xterm 自己的窗口。终端引擎在这个应用里启动，不会再打开系统浏览器：

```bat
run.bat
```

默认启动后命令窗口退出，后台服务继续运行。需要前台诊断时使用 `run.bat --fg`；这时关闭命令窗口会停止服务。可用 `--no-open` 禁止打开浏览器，或 `--port 8788` 指定端口。

默认端口被其他程序占用时，启动器会自动选择空闲端口；明确传入 `--port` 时保留指定端口。窗口启动后必须实际连接终端服务，启动器才返回成功；引擎退出、窗口启动失败和连接超时都会返回非零退出码并记录具体错误。再次启动只唤醒已存在的窗口，保留已有会话。

Linux / macOS 在项目目录运行：

```sh
sh ./run.sh
# 前台诊断：sh ./run.sh --fg
```

所有平台也可在安装依赖后运行 `npm run launch`（后台）或 `npm start`（前台）。入口都从脚本自身位置定位项目，支持移动目录以及目录名包含中文和空格；不会创建目录硬链接、符号链接或 junction。项目不分发绑定安装目录的 `.lnk`，Windows 直接双击 `launcher.vbs`。更换操作系统时请重新安装依赖，不要复制其他平台的 `node_modules`。

页面启动所需的样式、脚本和字体均来自本地资源或系统字体，不需要访问 Google Fonts。外部字体样式表可能让浏览器等待网络响应，阻塞连接脚本，导致服务已经启动却一直显示“未连接服务器”；当前入口已移除这项依赖。

### 双击应用入口

Windows 双击：

```text
launcher.vbs
```

启动器会：

- 通过统一的 `launch.ps1` 自动检查和准备 Node、应用组件，不依赖当前工作目录或写死的安装路径；准备期间显示进度，成功后关闭命令窗口；
- 打开 xterm 应用窗口，而不是系统浏览器。窗口出现前会先把本机终端引擎拉起来；
- 同一时刻只允许一个应用实例。再次双击只会把已有窗口带到前面；
- 引擎已在运行时直接打开窗口，不另起进程，也不会中断已有 SSH 会话；
- 这个应用进程自己启动的引擎，会在关闭窗口时一起退出。之前已经在后台运行的引擎会保留。

### 双击停止后台服务

需要彻底结束后台服务或加载更新后的代码时，双击：

```text
stop.vbs
```

确认提示后，它会通过 `http://127.0.0.1:8787/launcher-info` 核实服务身份，只结束该 xterm 实例返回的准确 PID，不会批量结束其他 `node.exe` 进程。停止服务会断开当前 SSH、VNC 和文件传输连接；需要再次启动时双击 `launcher.vbs`。

也可以手动执行隐藏启动脚本：

```powershell
# 在项目目录中执行，也可给出当前项目的实际路径
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File .\launch.ps1
```

或在终端前台手动启动：

```bash
npm install      # 仅首次或依赖发生变化时需要
npm start
# 浏览器打开 http://127.0.0.1:8787
```

### 启动故障排查

`launcher.vbs` 启动失败会显示错误提示；终端入口返回非零退出码。如果没有打开页面，请检查以下日志（Linux / macOS 位于 `~/.xterm/logs/`）：

```text
%USERPROFILE%\.xterm\logs\launcher.log
%USERPROFILE%\.xterm\logs\desktop.log
%USERPROFILE%\.xterm\logs\server-stderr.log
%USERPROFILE%\.xterm\logs\server-stdout.log
```

桌面启动确认通过 Electron 的结构化实例数据传递，并核对每次启动的唯一标识；连续双击、同时启动和唤醒已有窗口也必须确认页面已连接。`desktop.log` 记录实际桌面 PID、请求标识和确认结果，避免命令行参数变化导致把确认文件写到错误的位置。

勾选“记住密码”后，密码使用当前 Windows 用户的 DPAPI 加密保存到
`%USERPROFILE%\.xterm\secrets.enc`。如果旧版本生成的加密文件已经损坏，编辑会话重新输入一次密码并保存即可重建；之后 launcher 或服务重启都能自动恢复凭据。

常用检查命令：

```powershell
where.exe node
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/
```

如果 `where.exe node` 找不到 Node.js，请先安装 Node.js；如果依赖尚未安装，请运行一次 `run.bat` 或 `npm install`。

源码自动安装会检测无法连接的本地代理，仅对当前安装忽略失效代理，不改写全局 npm 配置。Electron 官方下载不可用时，会重试官方安装文档提供的镜像并保留校验和验证；自定义 `ELECTRON_MIRROR` 会优先保留。受限网络环境请直接使用已构建的离线便携 ZIP。

## 功能

| 协议 | 支持 | 说明 |
|---|---|---|
| SSH | 密码 / 密钥认证 | 交互式 shell,支持 resize |
| SSH 文件 | **SFTP 浏览 + 上传/下载** | 支持进度、断点续传；大文件及目录 ZIP 直接流式写盘，不占用整文件内存 |
| Telnet | 基本 + 自动登录 | IAC 协商,login/Password 自动填充 |
| 串口 | 全参数 + HEX 模式 | COM 口自动枚举,波特率至 921600 |

- 多标签:每标签一个连接,随时切换/关闭
- 刷新保持连接:Ctrl+F5 后浏览器会重新挂接原 SSH/Telnet/串口连接（默认后台无限保留），不重复登录或执行自动命令
- 分屏:当前标签可逐次增加分屏，最多 4 格（2×2）；双格时可拖动分隔条，单格用 ✕ 关闭
- 工作区:保存并恢复标签顺序、打开的会话以及分屏数量/比例（浏览器存储不保存密码和私钥）
- VNC 远程桌面:在“＋ 新建连接”中选择 VNC，每个连接作为独立标签页运行，不依赖 SSH/终端会话
- 会话管理:保存/编辑/删除,服务重启后从 `%USERPROFILE%\.xterm\sessions.json` 自动恢复；写入时保留 `.bak` 备份
- 双击左侧会话直接连接;悬停可编辑/删除
- 中文输入、256 色、滚动缓冲(5000 行)

## 复制粘贴(Xshell 习惯)

| 操作 | 效果 |
|---|---|
| 鼠标拖选文本 | **自动复制**(首次使用浏览器可能询问剪贴板权限,允许即可) |
| 右键点击终端 | 粘贴剪贴板 |
| Ctrl+Shift+C / Ctrl+Shift+V | 复制 / 粘贴 |
| Ctrl+C | 有选中文本 → 复制;无选中 → 照常发 SIGINT(中断命令) |
| Ctrl+V | 粘贴 |

## 使用

1. 点 **＋ 新建连接**(或 Ctrl+N),选类型填参数;
2. SSH:主机/端口/用户名/密码,或选密钥认证填私钥路径;
3. 串口:选 COM 口和波特率,勾 HEX 可十六进制收发;
4. **保存并连接** 存入左侧列表;**连接** 只连不存;
5. 多开:重复新建即可,相同配置自动复用连接。

### 分屏与工作区

1. 连接一个会话后点击 **分屏**，每次增加一个相同配置的独立终端，最多 4 格（2×2）；已达上限时状态栏提示；用各分屏 ✕ 关闭；
2. 拖动两个终端之间的分隔条可调整宽度；
3. 点击 **工作区 → 保存当前工作区**，保存标签、顺序及分屏布局；
4. 点击 **工作区 → 恢复已保存工作区**，关闭当前标签并重新建立保存的布局；
5. 工作区不会在浏览器中保存密码或私钥，未勾选“记住密码”的会话恢复时可能需要重新认证。

### 刷新页面

- `Ctrl+F5` 只重建浏览器界面；后台连接默认保留并由新页面重新挂接（可通过环境变量 `XTERM_DETACHED_GRACE_MS` 配置孤儿连接清理）；
- 刷新期间产生的最近 256 KB 终端输出会在挂接后补发；
- 重新挂接不会再次执行“连接后执行”命令；
- 服务器进程重启时浏览器会自动刷新 token 并退避重连 WebSocket；远端主动断开或网络中断则按各标签的重连策略处理。

### VNC 远程桌面

1. 点击 **＋ 新建连接**，在“类型”中选择 **VNC**；
2. 填写会话名称、VNC 服务器 IP/主机名和端口，例如显示器 `:1` 通常使用 `5901`，`:2` 使用 `5902`；
3. 输入 VNC 密码并连接；选择“保存并连接”时，可用 Windows DPAPI 加密记住密码，密码不会写入浏览器存储；
4. 每个 VNC 连接都会打开独立标签页，可同时保持多个 VNC、SSH、Telnet 或串口会话；
5. VNC 采用独立 TCP 直连，不依赖任何 SSH 标签。会话内支持重连、断开、只读模式、Ctrl+Alt+Del 和全屏；关闭一个 VNC 标签不会影响其他会话。

## 架构

```
浏览器 (xterm.js 渲染 + 多标签 UI)
   ↕ WebSocket (binary 数据流 + JSON 控制)
Node 服务端 (localhost:8787)
 ├─ ssh2      → SSH 会话
 ├─ net       → Telnet 会话
 └─ serialport→ 串口会话
会话持久化 → %USERPROFILE%\.xterm\sessions.json
```

- 只监听 `127.0.0.1`,不对外暴露;
- 会话元数据保存在本地 JSON；只有勾选“记住凭据”时，密码/私钥等才使用当前 Windows 用户的 DPAPI 加密保存在 `secrets.enc`，不会写入 JSON 或浏览器存储。

## 目录

```
server/               Node 服务端
  index.js            入口: HTTP + WS + 连接管理
  connections/        协议插件 (base/ssh/telnet/serial)
web/                  前端 (index.html / app.js / style.css)
tests/                e2e 测试 (SSH/Telnet/串口)
perf-proto/           链路压测原型 (性能验证)
run.bat               Windows 后台启动/首次安装依赖（--fg 前台诊断）
run.sh                Linux / macOS 启动入口
launcher.vbs          Windows 无窗口启动入口
launch.ps1            PowerShell 启动入口（-NoBrowser / -Port / -Foreground）
scripts/launch.js     共用启动器：目录解析、后台启动、健康检查、浏览器及日志
stop.vbs              安全识别并停止后台 xterm 服务
```

## 已知边界

- **Zmodem**：未支持 / 未实现用户确认收发（浏览器侧不再加载半成品 Sentry 检测；服务端接收器保持惰性，不作为产品能力宣传）；
- 串口收发回环需对端设备(或安装 com0com 虚拟串口对,见下);
- 目录 ZIP 会跳过符号链接以及扫描后消失/无法读取的文件，并在进度与完成状态中显示跳过数量；
- 使用 `launcher.vbs` 时，关闭浏览器不会停止后台服务，再次启动会使用仍在后台内存中的凭据恢复会话；如需彻底停止，可在工具栏选择“全部关闭”后双击 `stop.vbs`；
- 使用 `run.bat --fg`、`sh ./run.sh --fg` 或 `npm start` 时，关闭前台终端会停止服务；
- 独立 EXE：本地可用 `npm run build:exe`（caxa）打出 `dist/xterm.exe`；**对外分发**须走 GitHub Actions 签名发布（见 `docs/RELEASE.md`），不要手传未签名包。

### 串口回环验证(可选)

无真机时可用虚拟串口对验证收发:安装 [com0com](https://sourceforge.net/projects/com0com/) 后配对 COM28↔COM29,
一个标签连 COM28,另一个连 COM29,互发互收。

## 性能

实测(perf-proto/):串口 921600 全速、SSH 高速输出下,WS 链路延迟 <2ms、0 丢包;
xterm.js 渲染与 VSCode 终端同款,高速输出自动丢中间帧,UI 不冻结。
