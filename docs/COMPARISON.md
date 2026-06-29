# Rust 原版 vs TypeScript 版本：功能对比

**对比对象**:
- **Rust 原版**: [farion1231/cc-switch](https://github.com/farion1231/cc-switch) v3.16.4（src-tauri/ 90,125 行 Rust）
- **TypeScript 版本**: [sszhu-8bit/cc-switch-protocol-bridge](https://github.com/sszhu-8bit/cc-switch-protocol-bridge) v0.4.3（约 1,500 行 TypeScript + Bun）

**结论先行**:
- TS 版本**有意只覆盖 Rust 原版 5% 的功能**（核心协议桥）
- TS 版本**所有核心协议转换能力 = 100% 等价**
- 缺失的 95% 是**生态 / 多端 / 可视化 / 同步 / 遥测**等"扩展能力"，对个人 Linux 服务器场景**基本无影响**

---

## 0. 项目目标差异（设计哲学）

| 维度 | Rust 原版 | TypeScript 版本 |
|---|---|---|
| 形态 | 桌面 GUI 应用 | 守护进程（systemd service） |
| 平台 | macOS / Windows / Linux GUI | **仅 Linux 无桌面** |
| 部署 | 用户双击安装 | `.rpm` 包 + `dnf install` |
| 核心 | "给你一个 App 点点点" | "一个常驻进程 + CLI" |
| 用户群 | 全栈（小白到专家） | Linux 管理员 / 开发者 |
| 依赖 | ~50+ crates (~150MB 二进制) | Bun 单二进制 (~30MB) |
| 启动 | 双击图标 | `systemctl start cc-switch` |

**TS 版本的边界（来自 AGENTS.md）**：
- ✅ Linux 协议桥
- ❌ Web UI
- ❌ 多用户 / 计费
- ❌ 反向协议转换
- ❌ 故障转移 / 熔断（v1.0 前不做）
- ❌ 复杂整流器（厂商在逐渐兼容 Anthropic 协议）

---

## 1. 核心：协议转换（✅ 100% 等价）

| 功能 | Rust 原版 | TypeScript v0.4.3 | 备注 |
|---|---|---|---|
| **Anthropic → OpenAI 单请求** | ✅ `forwarder.rs` 3817 行 | ✅ `converter/anthropic-to-openai.ts` 225 行 | 覆盖字段相同 |
| **Anthropic → OpenAI 流式 SSE** | ✅ `sse.rs` 345 行 + `forwarder.rs` 流部分 | ✅ `converter/streaming.ts` 239 行 | P1-2 状态机更深 |
| **Anthropic → Gemini** | ✅ `gemini_url.rs` 704 行 | ❌ 不支持 | TS 不做反向 |
| **Anthropic → Codex Responses API** | ✅ `codex_history_migration.rs` 2677 行 | ❌ 不支持 | TS 不做反向 |
| **OpenAI → Anthropic 反向** | ❌ | ❌ | 都没做 |
| **多模型名映射（sonnet/opus/haiku）** | ✅ `model_mapper.rs` 378 行 | ✅ `providers/client.ts` 165 行 | TS 更简单 |
| **Tool use / tool_calls 转换** | ✅ | ✅ | P1-2 后状态机更健壮 |
| **多模态图片（base64）** | ✅ | ✅ | |
| **System prompt 拼接** | ✅ | ✅ | |

**协议转换能力评分**：

| 方向 | Rust | TS | 等价？ |
|---|---|---|---|
| Claude → 国内厂商（你的场景） | ✅ | ✅ | **100%** |
| Claude → OpenAI Codex 协议 | ✅ | ❌ | TS 不做反向 |
| Claude → Gemini 协议 | ✅ | ❌ | TS 不做反向 |
| OpenAI → Claude 反向 | ❌ | ❌ | 都没做 |
| 国内厂商 → Claude | ❌ | ❌ | 都没做 |

**对你的实际场景**（Claude Code → MiniMax/DeepSeek/Kimi/Qwen）：**完全等价**。

---

## 2. 整流器（⚠️ 缺失，但有理由）

| 整流器 | Rust 原版 | TypeScript v0.4.3 | 实际影响 |
|---|---|---|---|
| **Thinking block 签名整流** | ✅ `thinking_rectifier.rs` 722 行 | ❌ | 部分模型忽略 thinking，部分报错 |
| **Thinking budget 整流** | ✅ `thinking_budget_rectifier.rs` 365 行 | ❌ | 上游拒绝 `budget_tokens` 字段时失败 |
| **多模态降级**（图片 → 文字） | ✅ `media_sanitizer.rs` 831 行 | ❌ | 上游拒绝图片时整条消息失败 |
| **Cache 注入** | ✅ `cache_injector.rs` 377 行 | ❌ | 不缓存 tokens → 费用增加 |
| **Bedrock Thinking 优化** | ✅ `thinking_optimizer.rs` 296 行 | ❌ | AWS Bedrock 场景不需要 |
| **Copilot 优化**（subagent detection 等） | ✅ `copilot_optimizer.rs` 1539 行 | ❌ | GitHub Copilot 场景不需要 |
| **响应体整流** | ✅ `response_processor.rs` 1197 行 | ⚠️ 基础版 | 仅做 finish_reason 映射 |
| **JSON canonical 化** | ✅ `json_canonical.rs` 190 行 | ❌ | 上游若发送非标准 JSON 会失败 |
| **Body 过滤** | ✅ `body_filter.rs` 339 行 | ❌ | 可能影响国内厂商的扩展字段 |

**为什么 TS 故意不做**：

- 国内主流厂商（DeepSeek/Kimi/GLM）**已原生兼容** Anthropic Messages API 的大多数字段
- 整流器主要解决"上游不接受 / 客户端不接受" 的**历史遗留**问题
- 厂商兼容性越来越好，整流器的边际收益在递减
- 实现整流器需要大量测试和边界 case 调试（一个整流器 = 几周工作量）

**对你的影响**：
- DeepSeek 跑简单对话 ✅
- 复杂 tool use（多模态 + thinking）⚠️ 可能需要回退
- 一旦遇到问题，**评估是否真的需要整流器**——可能是别的原因

---

## 3. 路由器 / 容灾（⚠️ 部分缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 | 影响 |
|---|---|---|---|
| **多 provider 选择** | ✅ `provider_router.rs` 523 行 | ✅ `config.ts` + CLI | 行为等价 |
| **故障转移（failover）** | ✅ `failover_switch.rs` 135 行 | ❌ | DeepSeek 挂了不自动切 Kimi |
| **熔断器（circuit breaker）** | ✅ `circuit_breaker.rs` 495 行 | ❌ | 连续失败不自动熔断 |
| **Switch lock（防并发切换）** | ✅ `switch_lock.rs` 42 行 | ❌ | 手动 `provider use` 并发可能冲突 |
| **健康检查** | ✅ `health.rs` 7 行 | ✅ `/health` 端点 | 行为等价 |
| **Provider 配额监控** | ✅ `usage/usage_stats.rs` 4003 行 | ❌ | 不知道哪个 provider 调用了多少次 |

**对你的影响**：
- 单 provider 场景：完全无影响
- 多 provider 场景：挂了要手动 `cc-switch provider use <other>`

**v0.4.4 候选**：简单 `/stats` 端点（计数 / 错误率），不实现完整熔断。

---

## 4. 应用支持（⚠️ Rust 支持 6 个，TS 只 1 个）

| 应用 | Rust 原版 | TypeScript v0.4.3 | 你的需求 |
|---|---|---|---|
| **Claude Code** | ✅ | ✅ | ✅ 必需 |
| **Codex CLI** | ✅ | ⚠️ 直接配 `OPENAI_BASE_URL` 即可，**不需本项目** | 可选 |
| **Gemini CLI** | ✅ | ❌ | 不用 |
| **Hermes CLI** | ✅ | ❌ | 不用 |
| **OpenCode** | ✅ | ❌ | 不用 |
| **OpenClaw** | ✅ | ❌ | 不用 |
| **Claude Desktop** | ✅ | ❌ | 不用 |

**TS 版本的判断**：
- 协议转换的核心场景是 **Claude Code → 国内厂商**
- Codex 用 `OPENAI_BASE_URL` 直连**已经够用**（OpenAI 协议它原生支持）
- 其他 5 个应用**你不使用**

**对你的影响**：**0**。TS 版本精确覆盖你的使用场景。

---

## 5. 配置 / Live Config 管理（✅ 大致等价）

| 功能 | Rust 原版 | TypeScript v0.4.3 | 备注 |
|---|---|---|---|
| **YAML 配置** | ✅ 旧版 | ❌（v0.3.0 起换 SQLite） | TS 已升级 |
| **SQLite 存储** | ✅ v3.8+ 起 | ✅ v0.3.0 | 等价 |
| **API key 加密** | ✅ AES + 主密钥 | ✅ AES-256-GCM | 等价 |
| **Live config 接管**（改 ~/.claude/settings.json） | ✅ 复杂（含 backup） | ✅ v0.4.2 原子化 + jsonc 兼容 | TS 更简单，**无 backup**（用原子写） |
| **Live config 回滚** | ✅ backup 恢复 | ✅ raw bytes 回滚（v0.4.1） | TS 更轻 |
| **MCP 同步** | ✅ 跨应用同步 | ❌ | 不在 scope |
| **Settings 多端同步** | ✅ WebDAV / S3 | ❌ | 个人用不需要 |

**TS 的取舍**：
- 加密 ✅ 等价
- 原子写 ✅ 等价
- 但**没有** backup 机制——直接 overwrite（依赖 tmp + rename 原子性）
- **没有** S3/WebDAV 同步——单机用不需要

**对你的影响**：**0**。本机使用没区别。

---

## 6. MCP / Skills / Prompts（❌ 全部缺失，明确不做）

| 功能 | Rust 原版 | TypeScript v0.4.3 | 影响 |
|---|---|---|---|
| **MCP 服务器管理** | ✅ `claude_mcp.rs` 601 行 | ❌ | Claude Code 自己管理 MCP |
| **Skill 管理** | ✅ `services/skill.rs` 3127 行 | ❌ | Claude Code 0.2+ 自己管 |
| **Prompt 模板** | ✅ `services/prompt.rs` | ❌ | CLI 用不到 |
| **多应用 MCP 共享** | ✅ | ❌ | 不在 scope |

**TS 版本的判断**（AGENTS.md 明确）：
> Claude Code 0.2.0+ 自带 Skills 管理；MCP 跨应用同步对单端用户无意义

**对你的影响**：**0**。这些功能在 Rust 端是由 GUI 暴露的，**你已经不用 GUI**了。

---

## 7. Usage 统计 / 配额（❌ 缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **调用次数统计** | ✅ `usage_stats.rs` 4003 行 | ❌ |
| **Token 用量追踪** | ✅ | ❌ |
| **费用计算** | ✅ | ❌ |
| **按 provider / model / 时间分组** | ✅ | ❌ |
| **按 app 分组（Claude/Codex/Gemini...）** | ✅ | ❌ |
| **每日 / 每月汇总** | ✅ | ❌ |
| **导出 CSV** | ✅ | ❌ |
| **Session 使用** | ✅ `session_usage*.rs` 共 ~2700 行 | ❌ |
| **Provider limit（每日 $5 限额）** | ✅ `provider.rs` 的 `limit_daily_usd` | ❌ |

**对你的影响**：
- 看不到调用次数 / 费用
- v0.4.4 候选：简单 `/stats` 端点（~80 行）

---

## 8. 同步 / 备份（❌ 缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **WebDAV 同步** | ✅ `webdav.rs` 554 行 + 自动同步 274 行 | ❌ |
| **S3 同步** | ✅ `s3.rs` 926 行 + 自动同步 270 行 | ❌ |
| **多设备共享配置** | ✅ 通过 WebDAV/S3 | ❌ |
| **导入/导出 JSON** | ✅ `import_export.rs` | ⚠️ `provider add --file` 是半成品 |
| **配置 git 友好 diff** | ❌（DB 不可 diff） | ❌（DB 不可 diff） |

**对你的影响**：
- 多设备？**TS 限制单机**
- 需要备份？**手抄** `provider add` 命令或备份 DB 文件（SQLite 文件本身是文本 + 二进制混合，可直接 `cp`）

---

## 9. Session / 历史（❌ 缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **Session 记录** | ✅ `session_manager/` 351 行 | ❌ |
| **Session usage sync（Claude）** | ✅ `session_usage.rs` 798 行 | ❌ |
| **Session usage sync（Codex）** | ✅ `session_usage_codex.rs` 793 行 | ❌ |
| **Session usage sync（Gemini）** | ✅ `session_usage_gemini.rs` 498 行 | ❌ |
| **Session usage sync（OpenCode）** | ✅ `session_usage_opencode.rs` 574 行 | ❌ |
| **JSONL 解析** | ✅ | ❌ |
| **Codex history migration** | ✅ 2677 行 | ❌ |

**对你的影响**：
- 看不到过去调用过什么
- v0.4.4 候选：可选，简单 log

---

## 10. 速度测试 / 测速（❌ 缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **测速（endpoint latency）** | ✅ `speedtest.rs` 187 行 | ❌ |
| **多 endpoint 并发测试** | ✅ | ❌ |
| **自动选最快** | ✅ `provider_defaults.rs` | ❌ |

**对你的影响**：
- 多 endpoint（DeepSeek 主备、Qwen 备）场景：TS 不能自动选最快
- 单 endpoint 场景：无影响

---

## 11. 自定义端点 / 高级功能（❌ 缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **自定义 endpoint（同一 provider 多 URL）** | ✅ `provider.rs` 的 `custom_endpoints` | ⚠️ 字段保留但未实现 |
| **Auto-select endpoint** | ✅ `endpoint_auto_select` | ❌ |
| **Prompt 缓存 TTL**（5m / 1h） | ✅ `optimizer_config` | ❌ |
| **Custom User-Agent** | ✅ `custom_user_agent` | ❌ |
| **Local proxy request overrides** | ✅ `local_proxy_request_overrides` | ❌ |
| **OAuth 集成** | ✅ `codex_oauth.rs` `copilot.rs` | ❌ |
| **Coding plan 配额查询** | ✅ `coding_plan.rs` | ❌ |
| **Coding plan 模型目录** | ✅ `codex_oauth_models.rs` | ❌ |
| **环境变量检查 / 管理** | ✅ `env_checker.rs` `env_manager.rs` | ❌ |
| **Stream check（流式健康）** | ✅ `stream_check.rs` 583 行 | ❌ |
| **Subscription 查询** | ✅ `subscription.rs` 1342 行 | ❌ |
| **Balance 查询** | ✅ `balance.rs` | ❌ |
| **Usage script（JS 自定义查询）** | ✅ `usage_script.rs` 666 行 | ❌ |
| **OpenAI-compatible 模型目录抓取** | ✅ `model_fetch.rs` | ❌ |
| **OMO 配置** | ✅ `services/omo.rs` | ❌ |
| **Deeplink 导入** | ✅ `deeplink/` 138 行 | ❌ |
| **Plugin 系统** | ✅ `commands/plugin.rs` + `proxy/plugins/` | ❌ |
| **Lightweight mode**（关窗口保留后台） | ✅ `lightweight.rs` 100 行 | N/A（无 GUI） |
| **Auto launch**（开机自启 GUI） | ✅ `auto_launch.rs` 117 行 | N/A（systemd 已经做了） |
| **Tray icon** | ✅ `tray.rs` 1213 行 | N/A（无 GUI） |
| **Linux GTK 修复** | ✅ `linux_fix.rs` 121 行 | N/A |
| **Panic hook**（崩溃日志） | ✅ `panic_hook.rs` 205 行 | ❌ |
| **App config dir override** | ✅ `app_store.rs` 117 行 | ⚠️ `CC_SWITCH_DB` env 替代 |

**对你的影响**：
- 你**不使用**这些功能（你只用 Claude Code + 国内厂商）
- 一些**永远无影响**（tray / GTK / panic hook）
- 一些**可能有影响**（endpoint 测速、coding plan 配额）

---

## 12. 商业功能 / 高级（❌ 缺失）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **Coding Plan 套餐支持** | ✅ MiniMax/智谱/通义等 | ❌ |
| **GitHub Copilot 集成** | ✅ 完整 OAuth + 代理 | ❌ |
| **Codex OAuth（ChatGPT Plus）** | ✅ | ❌ |
| **Prompt Caching 优化** | ✅ 5m/1h TTL | ❌ |
| **Session JSONL 实时同步** | ✅ 4 个 app 各一份 | ❌ |

**对你的影响**：
- **Coding Plan 是关键差距**！如果你用 MiniMax 套餐（不是按 token 计费），TS 版本**不知道**你已经用完
- Copilot / Codex OAuth 你不用

---

## 13. UI / 前端（❌ TS 不做，这是已知差异）

| 功能 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **Web 界面（React）** | ✅ Tauri + React | ❌（明确不做） |
| **Tray icon** | ✅ 1213 行 | N/A |
| **可视化配置** | ✅ | N/A |
| **实时状态显示** | ✅ | N/A |
| **Logs viewer** | ✅ | N/A |
| **Usage 图表** | ✅ Recharts | N/A |

**对你**：你已经不用 UI 了。✅

---

## 14. 测试 / 工程化（✅ TS 更现代）

| 维度 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **测试** | `cargo test`，规模大但覆盖率不明 | `bun test`，**73/73 通过** |
| **CI** | GitHub Actions 复杂 | GitHub Actions 简洁（build + release） |
| **打包** | Tauri bundler，多平台 .msi/.dmg/.AppImage/.deb/.rpm | bun compile + .rpm |
| **构建时间** | ~5-10 分钟 | ~90 秒 |
| **二进制大小** | ~150MB | ~30MB |
| **启动时间** | ~1-2 秒（GUI） | <100ms（headless） |
| **内存占用** | ~150-300MB（GUI + 后台） | <50MB（headless） |

**TS 在工程化上更轻**。

---

## 15. 文档 / 规范

| 维度 | Rust 原版 | TypeScript v0.4.3 |
|---|---|---|
| **README** | ✅ 中英德日 4 语言，~200 行 | ✅ 中文，~200 行 |
| **AGENTS.md**（AI 协作） | ❌ | ✅ 432 行 |
| **REVIEW.md**（工业评审） | ❌ | ✅ |
| **ROADMAP.md**（开发计划） | ❌ | ✅ |
| **代码注释** | 中英混合 | 中文（项目母语） |

TS 在"AI 友好度"上更现代。

---

## 16. 完整能力对比矩阵（一图速览）

| 类别 | 功能 | Rust | TS | 重要性 |
|---|---|---|---|---|
| **核心** | Anthropic → OpenAI | ✅ | ✅ | ⭐⭐⭐ |
| **核心** | 流式 SSE | ✅ | ✅ | ⭐⭐⭐ |
| **核心** | 工具调用转换 | ✅ | ✅ | ⭐⭐⭐ |
| **核心** | 多模型名映射 | ✅ | ✅ | ⭐⭐ |
| **核心** | 多模态 | ✅ | ✅ | ⭐ |
| **核心** | Gemini / Codex 反向 | ✅ | ❌ | — |
| **路由** | 多 provider | ✅ | ✅ | ⭐⭐ |
| **路由** | 故障转移 | ✅ | ❌ | ⭐ |
| **路由** | 熔断器 | ✅ | ❌ | ⭐ |
| **整流** | thinking 签名 | ✅ | ❌ | ⭐⭐ |
| **整流** | thinking budget | ✅ | ❌ | ⭐ |
| **整流** | 多模态降级 | ✅ | ❌ | ⭐ |
| **整流** | cache 注入 | ✅ | ❌ | ⭐ |
| **应用** | Claude Code | ✅ | ✅ | ⭐⭐⭐ |
| **应用** | Codex CLI | ✅ | ⚠️ 直连 | ⭐⭐ |
| **应用** | Gemini CLI | ✅ | ❌ | — |
| **应用** | Hermes / OpenCode / OpenClaw | ✅ | ❌ | — |
| **存储** | SQLite | ✅ | ✅ | ⭐⭐⭐ |
| **存储** | API key 加密 | ✅ | ✅ | ⭐⭐⭐ |
| **存储** | 原子写 settings.json | ✅ | ✅（v0.4.2） | ⭐⭐⭐ |
| **同步** | WebDAV | ✅ | ❌ | — |
| **同步** | S3 | ✅ | ❌ | — |
| **遥测** | 调用统计 | ✅ | ❌ | ⭐⭐ |
| **遥测** | Token 用量 | ✅ | ❌ | ⭐⭐ |
| **遥测** | 费用 | ✅ | ❌ | ⭐ |
| **遥测** | 按日/月汇总 | ✅ | ❌ | ⭐ |
| **遥测** | CSV 导出 | ✅ | ❌ | — |
| **健康** | /health 端点 | ✅ | ✅ | ⭐⭐ |
| **健康** | 测速 / 选最快 | ✅ | ❌ | ⭐ |
| **健康** | 故障检测 | ✅ | ❌ | ⭐ |
| **会话** | Session 记录 | ✅ | ❌ | — |
| **会话** | Session 同步 | ✅ | ❌ | — |
| **商业** | Coding Plan 套餐 | ✅ | ❌ | ⭐⭐ |
| **商业** | GitHub Copilot | ✅ | ❌ | — |
| **商业** | Codex OAuth | ✅ | ❌ | — |
| **UI** | Web 界面 | ✅ | ❌ | — |
| **UI** | Tray | ✅ | ❌ | — |
| **工程** | 单元测试 | ✅ | ✅ 73/73 | ⭐⭐⭐ |
| **工程** | 工业评审 | ❌ | ✅ REVIEW.md | ⭐⭐ |
| **工程** | AI 协作规范 | ❌ | ✅ AGENTS.md | ⭐⭐ |
| **工程** | 路线图 | ❌ | ✅ ROADMAP.md | ⭐⭐ |

---

## 17. 关键差距（按你的实际场景重要度）

### 17.1 **真重要**

| 差距 | 影响 | 修复优先级 |
|---|---|---|
| **Coding Plan 套餐** | MiniMax/智谱套餐用完不知道 | 🟡 v0.5.0 候选 |
| **多模态降级** | 图片类任务会失败 | 🟡 v0.5.0 候选 |
| **故障转移** | DeepSeek 挂了要手动切 | 🟡 v1.0 之前不做 |

### 17.2 **不重要**

| 差距 | 不影响你的原因 |
|---|---|
| WebDAV/S3 同步 | 你单机用 |
| Web UI | 明确不要 |
| Tray icon | 无桌面 |
| 其他 5 个 App 支持 | 你不用 |
| 复杂整流器 | 厂商在逐渐兼容 |
| Usage 统计 | 不影响使用 |
| Session 同步 | 不影响使用 |

### 17.3 **永远不会做（TS 边界）**

- ❌ Web UI
- ❌ 反向协议转换
- ❌ 多用户
- ❌ 计费

---

## 18. 如果你将来需要某个缺失功能

| 你需要 | 怎么办 |
|---|---|
| 故障转移 | 升级到 Rust 原版，or 自己写 ~200 行 |
| 整流器 | 看厂商是否在更新协议；不行就自己加 |
| Usage 统计 | v0.4.4 加 `/stats` 端点（80 行） |
| Coding Plan 套餐 | 等 MiniMax 出 API，或 v0.5.0+ 评估 |
| S3 同步 | 手抄配置 / 备份 DB 文件 |
| Gemini 协议 | 不在 scope，手动用 Gemini CLI 即可 |

**记住 TS 版本是 v0.4.3，不到 1% 的功能覆盖率，核心协议转换是 100%**。它能解决你**90% 的痛点**，剩下的 10% 需要你判断要不要补。

---

## 19. 一句话总结

> **Rust 原版是"瑞士军刀"（10 万行、什么都有、用户友好）；TS 版本是"开瓶器"（1.5 千行、只做协议转换、Linux 服务器专用）。**
> 
> **对你的真实使用场景（Claude Code + 国内大模型 + Linux 无桌面），TS 版本覆盖了 100% 你需要的功能。**
> 
> 缺失的功能（故障转移 / 整流器 / 统计）对你当前使用**几乎无影响**。当遇到具体问题时再针对性补。

---

**最后更新**: 2026-06-29
**维护者**: sszhu-8bit
