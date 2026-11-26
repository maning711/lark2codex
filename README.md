# lark2codex

通过飞书私聊，在自己的 Mac 上创建、查询和续接 Codex 任务，完成后自动将结果发回飞书。

一个本地运行的提效工具：手机发任务，Mac 执行，桌面查看上下文。使用飞书官方 SDK 的 WebSocket 长连接，无需公网 IP、服务器或内网穿透。非飞书或 OpenAI 官方产品。

```mermaid
flowchart LR
    A[飞书私聊 / 卡片按钮] -->|WebSocket| B[Mac 本地桥接]
    B --> C[Codex App Server]
    C --> D[桌面可发现的会话]
    C -->|最终结果| B
    B -->|消息 API| A
```

## 能做什么

- 私聊发布任务，串行执行并自动回传最终结果；较长任务要求输出完成情况、产出、验证和待办。
- 新建独立会话，聊天标题以 `飞书 · ` 开头，可在 Codex 桌面历史中发现。
- 查询本机执行中及最近活跃的前 5 个未归档会话，按 ID 查看简报和续接。
- 卡片按钮触发测试任务。
- 所有者绑定、消息去重、持久队列、单实例锁、超时和回复重试。
- macOS launchd 登录后自动运行。

## 环境

- macOS，Node.js 22+，Python 3.9+（`/usr/bin/python3` 可用）。
- 已安装并登录的 Codex CLI，支持 `codex app-server --stdio`；桌面可见性在 Codex CLI 0.167.0 的本地环境验证过。协议和内部会话格式可能随版本变化。
- 飞书自建应用及机器人能力，自己处于应用可用范围内。

当前主要验证飞书国内版；SDK 使用飞书域名，国际版 Lark 未进行适配验证。

## 快速开始

```bash
git clone https://github.com/maning711/lark2codex.git
cd lark2codex
npm ci --ignore-scripts
codex login status
```

### 方式一：扫码创建应用

先确定 Codex 的任务工作目录（可与本仓库不同）：

```bash
CODEX_WORKSPACE=/absolute/path/to/your/project npm run register
```

打开打印的官方授权链接、扫码确认。创建前核对组织身份。凭证自动保存在本机，不会打印 Secret。若扫码结果包含用户 open_id，会绑定该用户；否则启动后按终端提示私聊机器人发送一次性 `/pair ...`。

未设置 `CODEX_WORKSPACE` 时，工作目录默认为运行命令的当前目录。

### 方式二：使用已有应用

```bash
npm run setup
```

在终端填写 App ID、隐藏输入的 App Secret、工作目录和 Codex 路径。不要将凭证写入仓库或发送到公共聊天。

### 检查飞书后台

在 [开发者后台](https://open.feishu.cn/app) 为应用配置：

1. 开启机器人能力，发布应用并确认自己在可用范围内。
2. 权限：`im:message.p2p_msg:readonly`、`im:message:send_as_bot`。
3. 事件与回调：使用长连接，订阅 `im.message.receive_v1`。
4. 卡片测试：回调配置使用长连接，订阅 `card.action.trigger`。

扫码流程申请上述权限和订阅，但请在后台核对接收方式与发布状态。

```bash
npm run doctor
npm start
```

`doctor` 不打印 Secret 或 Token，检查令牌及本地连接/队列状态。Mac 须保持唤醒和联网。

## 飞书命令

| 命令 | 用途 |
| --- | --- |
| 普通文字 | 在当前选中会话执行任务；尚无会话时创建新的聊天 |
| `/new` | 等队列空闲后，切换到新会话模式；下一条文字创建独立聊天 |
| `/tasks` | 执行中优先，其余按最近更新时间排序，最多 5 个 |
| `/brief 任务ID` | 提取最近请求、进展或结果，不调用模型 |
| `/use 任务ID` | 选择已结束当前轮次的会话，之后文字继续该会话 |
| `/continue 任务ID 后续指令` | 将指定会话的后续指令加入队列 |
| `/status` | 工作目录、队列、中断任务和选中会话 |
| `/panel` | 发送单次执行的连通性测试卡片 |
| `/help` | 命令列表 |

任务 ID 为 Codex 会话 ID，也接受至少 8 位且唯一的前缀。

例子：

```text
/new
```

然后发：

```text
分析工作目录中的代码，列出三个最值得改进的问题。完成后给我简报。
```

### 桌面聊天与写入锁

新任务使用 App Server 的 `thread/start`、`thread/name/set` 和 `turn/start`；续接使用 `thread/resume`，不通过写数据库伪造聊天来源。桌面历史索引可能延迟刷新，执行期间可能显示“未加载”，不保证工具与审批 UI 实时同步。

桌面可能在轮次结束后继续持有写入锁。若 `thread/resume` 在执行前明确返回 `already has an active writer`，桥接会复制已有上下文至新的 `飞书续接 · …` 会话，并通过飞书通知新 ID。原聊天保留，两个分支此后独立发展。其他错误及 `turn/start` 错误不会自动复制或重放任务。仍在执行或状态未知的会话拒绝续接。

旧的 `codex exec` 会话不自动迁移。默认共用配置的工作目录，独立聊天不代表独立文件目录。避免两端同时提交同一会话的任务。

## 后台运行

先停止前台 `npm start`，然后：

```bash
npm run service -- install
npm run service -- status
```

停止并移除自动启动（配置和历史保留）：

```bash
npm run service -- uninstall
```

检测到任务运行时拒绝安装/卸载，以免中断执行。此操作管理当前用户下的 `local.feishu-codex-bridge` 服务；同一用户只运行一个服务配置。

## 数据和权限

默认私有目录：`~/Library/Application Support/FeishuCodexBridge`。可用 `FEISHU_CODEX_HOME` 在配置、启动和服务管理命令中一致覆盖。

| 文件 | 内容 |
| --- | --- |
| `config.json` | 应用凭证、所有者、Codex 路径、工作目录、超时（默认 900 秒） |
| `state.json` | 请求与答案、队列状态、选中会话、去重和卡片记录 |
| `health.json` | 连接状态、最后入站、令牌诊断，不含 Token |
| `service.log` / `error.log` | 后台日志 |

配置权限 0600，目录权限 0700；凭证并非 Keychain 加密存储。已完成任务和去重记录目前不会自动清理，长期运行需自行安排保留周期。状态里含任务文本和答案。

仅接受配对所有者的私聊文字及本程序发出的测试卡片；不接入群聊、附件或语音。Codex 使用 `workspace-write`、`approvalPolicy=never`，继承本机登录及模型配置。需要人工审批/输入的请求会失败，当前没有远程审批转发。此桥接不会提升沙箱权限，也不保证所有插件都能在外部 App Server 中工作。

任务及回复会通过你配置的飞书应用传输；Codex 使用其现有模型服务。只将机器人授权给你信任的使用者。

## 诊断与恢复

- **21001 / platform policy**：令牌请求被飞书平台拒绝，不能靠重装或扩大权限假定解决。检查账号/组织/应用策略，携带 doctor 的请求 Log ID 联系飞书支持。部分豆包账号有 [相似报告](https://github.com/larksuite/openclaw-lark/issues/639)，不等于所有账号的官方规则。
- **没有消息**：检查发布、可用范围、所有者绑定、长连接与订阅。
- **没有卡片回调**：检查 `card.action.trigger` 配置。
- **重启后 interrupted**：不自动重跑，先检查是否已有文件改动再明确下达新请求。
- **回复失败**：结果保存在本地，重试只发送答案，不重复执行。21001 会暂停定时重试，解除后重启检查。
- **超时**：默认 15 分钟，需核对原任务结果再决定是否重试。
- **断网或休眠**：不保证飞书补发所有离线消息；检查是否收到排队提示。

任务列表和简报通过只读 SQLite 索引及 JSONL 会话记录获取，扫描最近 100 个会话后排序；单会话读取尾部最多 512 KB。仅提取用户/助手文字，不发送推理和工具输出。使用 Codex 内部数据格式并非稳定公共接口；异常退出可能造成执行状态滞后，升级后需验证兼容性。

## 开发与测试

```bash
npm test
python3 -m py_compile setup.py service.py sessions.py
```

13 项测试覆盖消息授权、配对、防重放、SQLite 真库查询、App Server 建聊与续接、写入锁恢复及避免错误重放。CI 使用 macOS 和 Node 22；模拟协议测试不代表所有 Codex 版本都完成端到端验证。

| 文件 | 职责 |
| --- | --- |
| `bridge.mjs` | 飞书接收、队列、命令、回复 |
| `desktop.mjs` | App Server JSON-RPC 和写入锁分支恢复 |
| `sessions.py` / `sessions.mjs` | 本地会话只读查询与简报 |
| `register.mjs` / `setup.py` | 扫码授权或手工配置 |
| `service.py` / `doctor.mjs` | 后台服务与诊断 |
| `core.mjs` | 消息校验、任务模型和旧 CLI 适配器 |

参考：[飞书 SDK](https://github.com/larksuite/node-sdk)、[飞书事件 Skill](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)、[Codex App Server](https://developers.openai.com/codex/app-server/)。

## License

[Apache-2.0](LICENSE)
