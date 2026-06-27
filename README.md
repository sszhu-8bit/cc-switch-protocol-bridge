# cc-switch-protocol-bridge

轻量级 Anthropic ↔ OpenAI 协议适配代理，让 Linux 服务器上的 Claude Code 用上 MiniMax、阿里通义、火山方舟等**只支持 OpenAI 兼容协议的国内大模型厂商**。

## 这是什么

Claude Code 默认发 Anthropic Messages API 请求。如果你想让它调用不支持 Anthropic 协议的国产模型（MiniMax M2、阿里通义 DashScope 等），需要有个中间层把 Anthropic 请求转成 OpenAI Chat Completions 请求，再把响应转回去。

本项目做的就是这件事：
- 监听 `127.0.0.1:15721`
- 把 Anthropic Messages API（含流式 SSE）翻译成 OpenAI Chat Completions
- 通过 systemd 守护进程运行
- 命令行管理 provider 列表

## 为什么不用 cc-switch（原作者版本）

原版 cc-switch 是 Tauri 桌面应用，含 GUI、整流器、复杂故障转移、MCP/Skill 管理等大量不需要的功能。本项目：
- 只保留"协议转换"核心
- 用 Node.js + bun 编译为单文件二进制，~30MB
- 不需要装 Node 运行时
- 编译成 `.rpm` 包，安装即用

## 支持的功能

✅ Anthropic → OpenAI 单请求转换  
✅ Anthropic → OpenAI 流式 SSE 转换  
✅ 文本内容、工具调用（tool_use → tool_calls）  
✅ 多模态图片（base64 → image_url）  
✅ system prompt  
✅ 多个 provider 切换  
✅ 自定义模型别名映射  
❌ thinking blocks 整流（暂不支持）  
❌ OpenAI → Anthropic 反向转换（不需要）  
❌ 故障转移/熔断器（暂不支持）  

## 安装

### 一键安装（推荐）

从 [Releases](https://github.com/yourname/cc-switch-protocol-bridge/releases) 下载最新的 `.rpm` 包：

```bash
sudo dnf install ./cc-switch-0.1.0-1.el9.x86_64.rpm
```

### AlmaLinux 9 / RHEL 9 / Rocky Linux 9 / CentOS Stream 9 / Fedora

```bash
sudo dnf install ./cc-switch-*.rpm
```

安装后会自动：
1. 创建 `ccswitch` 系统用户
2. 写入默认配置到 `/etc/cc-switch/config.yaml`
3. 注册 systemd 服务（但不启动）

## 配置 provider

编辑 `/etc/cc-switch/config.yaml`：

```yaml
listen_address: 127.0.0.1
listen_port: 15721
current_provider: minimax

providers:
  - id: minimax
    name: MiniMax M2
    vendor: minimax
    base_url: https://api.MiniMax.chat
    api_key: sk-your-actual-key
    models:
      sonnet: MiniMax-M2
      opus: MiniMax-M2
      haiku: MiniMax-M2

  - id: qwen
    name: Alibaba Qwen
    vendor: openai-compatible
    base_url: https://dashscope.aliyuncs.com/compatible-mode
    api_key: sk-your-actual-key
    models:
      sonnet: qwen-plus
      opus: qwen-max
      haiku: qwen-turbo
```

或者用命令行：

```bash
# 交互式添加
sudo cc-switch provider add-interactive

# 命令行添加
sudo cc-switch provider add \
    --id minimax \
    --name "MiniMax M2" \
    --vendor minimax \
    --base-url https://api.MiniMax.chat \
    --api-key sk-your-key \
    --sonnet-model MiniMax-M2

# 切换当前 provider
sudo cc-switch provider use qwen

# 列出所有 provider
sudo cc-switch provider list

# 查看状态
sudo cc-switch status
```

## 启动服务

```bash
sudo systemctl start cc-switch
sudo systemctl status cc-switch
sudo journalctl -u cc-switch -f
```

设置开机自启：
```bash
sudo systemctl enable cc-switch
```

## 接入 Claude Code

编辑 `~/.claude/settings.json`（Linux 上是 `~/.claude/settings.json`）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
    "ANTHROPIC_AUTH_TOKEN": "any-token-here",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus"
  }
}
```

启动 `claude`，流量会自动走本地代理，转发给当前激活的 provider。

## 卸载

```bash
sudo systemctl stop cc-switch
sudo dnf remove cc-switch
```

## 从源码构建

需要 [bun](https://bun.sh) 1.1+：

```bash
bun install
bun run build         # 输出 dist/cc-switch（Linux x64 二进制）
bun run dev           # 开发模式（前台运行）
bun test              # 测试
```

## 项目结构

```
cc-switch-protocol-bridge/
├── src/
│   ├── cli.ts                    # CLI 入口
│   ├── server.ts                 # Fastify HTTP 服务器
│   ├── config.ts                 # YAML 配置加载/保存
│   ├── logger.ts                 # pino 日志
│   ├── types.ts                  # 共享类型定义
│   ├── converter/
│   │   ├── anthropic-to-openai.ts   # 单请求协议转换
│   │   └── streaming.ts             # SSE 流式转换
│   └── providers/
│       └── client.ts             # 上游 HTTP 客户端
├── packaging/
│   ├── cc-switch.spec            # RPM spec 文件
│   ├── build-rpm.sh              # 本地构建脚本
│   ├── systemd/cc-switch.service
│   ├── postinstall.sh
│   ├── preremove.sh
│   └── postremove.sh
├── config/
│   └── config.example.yaml
├── .github/workflows/
│   └── build-rpm.yml             # CI：build + 打包 .rpm
└── README.md
```

## 工作原理

```
Claude Code
   │
   │ POST /v1/messages  (Anthropic Messages API)
   ▼
┌─────────────────────────────────┐
│ cc-switch (127.0.0.1:15721)    │
│   1. 解析 Anthropic 请求        │
│   2. 转 OpenAI Chat 请求        │
│   3. 发送上游                    │
│   4. 接收响应                    │
│   5. 转回 Anthropic 格式         │
└─────────────────────────────────┘
   │
   │ POST /v1/chat/completions  (OpenAI Chat Completions API)
   ▼
国内大模型厂商
(MiniMax / Qwen / 火山方舟 / ...)
```

## 已知限制

1. **不支持 thinking blocks**：Claude Code 的 extended thinking 会被丢弃。
2. **多模态图片**：仅支持 base64 input，不支持 URL 引用。
3. **不支持 streaming 的工具调用**（tool_use 流式）：复杂场景可能需要更新版本。
4. **每个进程只支持一个当前 provider**：不支持 per-request 路由。

## License

MIT

## 致谢

灵感来自 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) (MIT License)。本项目是独立的 TypeScript 重写，仅借鉴其架构思路。