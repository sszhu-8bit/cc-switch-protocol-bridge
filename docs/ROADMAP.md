# 开发路线图 (Roadmap)

**项目**: cc-switch-protocol-bridge
**仓库**: https://github.com/sszhu-8bit/cc-switch-protocol-bridge
**最后更新**: 2026-06-29

## 图例

- ✅ **已完成** (shipped)
- 🟡 **进行中 / 推荐下一步**
- ⚪ **暂缓 / 视情况**
- ❌ **明确不做**

---

## 整体目标

**在 Linux 无桌面环境下，让 Claude Code / Codex CLI 用上只支持 OpenAI 协议的国内大模型厂商（MiniMax、阿里通义、火山方舟）。**

设计原则：
- **轻量**：单二进制 ~30MB，零运行时依赖
- **稳定**：协议转换无状态、文件原子写、systemd 守护
- **易用**：一条命令切换 provider

---

## v0.1.0 — 协议转换核心 ✅ 已完成

**发布日期**: 2026-06-27
**Release**: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.1.0

### 范围
- Anthropic → OpenAI 单请求转换
- Anthropic → OpenAI 流式 SSE 转换
- Fastify HTTP 服务器（`127.0.0.1:17821`）
- CLI：`serve` / `status` / `provider add/list/remove/use/add-interactive`
- YAML 配置
- systemd system service 集成
- RPM 打包（AlmaLinux 9 / RHEL 9 / Rocky / Fedora）
- GitHub Actions CI：bun build → docker almalinux:9 → rpmbuild

### 不在范围
- ❌ thinking blocks 整流
- ❌ 反向协议转换（OpenAI → Anthropic）
- ❌ 故障转移 / 熔断器
- ❌ Web UI

### 实际投入
- 21 个文件 / 1981 行 TypeScript
- 7/7 单元测试通过
- 0 个 npm 依赖
- 编译时间 ~30s，RPM 构建 ~90s

---

## v0.2.0 — provider use 一条命令切换 ✅ 已完成

**发布日期**: 2026-06-27
**Release**: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.2.0

### 范围
- `provider use <id>` 自动改 `~/.claude/settings.json` + 重启 systemd
- 保留用户原有的 `mcpServers` / `permissions` / 自定义 env
- 原子写入 settings.json（tmp + rename）
- 新选项：`--no-restart` / `--no-write-claude` / `--claude-settings`

### 解决的问题
之前需要用户：
1. 手动编辑 `~/.claude/settings.json`
2. 手动 `systemctl restart cc-switch`

现在一条命令搞定。

### 实际投入
- 16/16 单元测试 + E2E 测试通过
- 增量代码：~400 行

---

## v0.3.0 — SQLite + AES-256-GCM 加密 ✅ 已完成

**发布日期**: 2026-06-29
**Release**: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.3.0

### 范围
- 替换 YAML 为 SQLite（`bun:sqlite`，零新依赖）
- API key 用 AES-256-GCM 加密存 `provider_secrets` 表
- 主密钥解析顺序：
  1. `CC_SWITCH_MASTER_KEY` 环境变量（hex/base64）
  2. `/etc/cc-switch/master.key` 文件
  3. 临时生成（开发模式）
- DB 文件 0o600 权限
- 新命令：`cc-switch key generate`

### 解决的问题
**P0-1**（评审报告中的最高优先级安全问题）：
- 之前：API key 存 YAML 明文
- 现在：DB 里只存密文，攻击者拿到 DB 也无法解

### 实际投入
- 29/29 测试通过（13 个新增 DB + crypto 测试）
- 增量代码：~500 行（src/store/db.ts）

### 破坏性更新
- 不再读 `config.yaml`
- 升级需重新 `provider add`
- 必须先生成 master key

---

## v0.4.0 — 稳定补丁系列 ✅ 已完成

发布 5 个补丁版，按 P0 风险递降修复：

| 版本 | 修复 | 对应 REVIEW 项 |
|---|---|---|
| **v0.4.0** | 流式断流恢复：上游断开时先发 `message_stop` 再发 `error`，让客户端干净收尾 | P0-3 |
| **v0.4.1** | `provider use` 事务化：快照 → 改 DB → 改 settings → restart → /health check，失败回滚 | P0-4 |
| **v0.4.2** | `~/.claude/settings.json` JSON5 兼容：用 `jsonc-parser` 保留注释 / 尾随逗号 / 字段顺序 | P0-4 漏洞 |
| **v0.4.3** | 流式工具调用状态机：延迟 `content_block_start` 等 `id+name` 都到；处理 DeepSeek / Qwen 分块顺序 | P1-2 |
| **v0.4.4** | `/stats` 端点：JSON metrics（总数 / 成功 / 失败 / 按 provider / 按状态码） | P1-4 |

**发布日期**: 2026-06-29（同日连发）
**Releases**:
- v0.4.0: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.4.0
- v0.4.1: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.4.1
- v0.4.2: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.4.2
- v0.4.3: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.4.3
- v0.4.4: https://github.com/sszhu-8bit/cc-switch-protocol-bridge/releases/tag/v0.4.4

### 投入
- 85/85 测试通过（v0.4.4 完成时）
- 增量代码：~500 行

### 修复的影响
- v0.4.0 + v0.4.1：让 `cc-switch provider use` 真正可用，失败可回滚
- v0.4.2：用户的 settings.json 不再被改坏
- v0.4.3：让 MiniMax / Qwen 等"分块"实现的工具调用能正确转换
- v0.4.4：能看见代理在干什么

---

## v0.5.0 — 工程化 🟡 推荐

**目标**: 提升可维护性、可观察性、稳健性（非功能需求）

### 已计划的功能

#### P2-1: zod 配置校验 ✅
**问题**: 损坏的 DB / 缺字段的 config → 运行时崩，错误信息不友好。

**方案**:
- 启动时用 zod 校验整个 AppConfig
- DB 缺失字段用默认值填充（不破坏老数据）
- 真正的损坏（手工改 DB）启动失败并报清晰错误

**状态**: 已完成（v0.5.0）

#### P2-2: 集成测试 ✅
**问题**: server 层 0 集成测试，所有路由逻辑靠单元测试 mock。

**方案**:
- 用 fastify `app.inject()` 测 server 层
- 覆盖 /health / /stats / /v1/messages / /v1/models
- 不需要真端口 / 真进程

**状态**: 已完成（v0.5.0）

#### CI 加 lint ✅
**问题**: 无静态检查，PR 容易引入风格 / 可读性问题。

**方案**:
- 加 biomejs/biome
- `bun run lint` 跑 lint check
- CI 失败 = lint 失败

**状态**: 已完成（v0.5.0）

### 实际投入
- 123/123 测试通过
- 增量代码：~700 行（zod schema 100 + stats 模块 100 + 集成测试 500）

---

## 未来版本

### v0.6.0 — 厂商生态扩展 ⚪

- 添加 MiniMax / DeepSeek / Kimi 厂商**预设**（一行 `--preset xxx` 自动填 base_url + 默认模型）
- 文档化每个厂商的特殊处理（thinking / 1M context / vision）

### v0.7.0 — 高级稳定性 ⚪

- 性能基准：模拟 1000 QPS 跑 1 小时，监控内存增长
- systemd hardening：MemoryDenyWriteExecute / SystemCallFilter / CapabilityBoundingSet
- 真实集成测试：mock OpenAI / DeepSeek 真实响应
- 覆盖率：> 80%

### v1.0.0 — 工业级 ⚪

- 公开发布公告（v0.4.x 系列已经在 0% crash rate 跑了几个月）
- 完整文档（FAQ / TROUBLESHOOTING / ARCHITECTURE）
- Homebrew / deb 包（覆盖 Debian / Ubuntu）
- Docker 镜像
- Prometheus `/metrics` 端点（v0.4.4 的 stats 是 JSON，Prometheus 是 text format）
- 真实厂商 E2E 测试套件（用 sandbox API key 跑通整条链路）

---

## 未来版本

### v0.6.0 — 厂商生态扩展 ⚪

- 添加 GLM / Qwen / 火山方舟预设
- `provider add` 接受 `--preset` 参数（如 `--preset deepseek` 自动填 base_url）
- 文档化每个厂商的特殊处理（thinking、1M context 等）

### v0.7.0 — 高级稳定性 ⚪

#### P2-1: 配置 schema 校验
用 zod 校验 config，启动时报错而不是运行时炸。

#### P2-2: 集成测试
- 用 fastify `app.inject()` 写 5-10 个 integration test
- 覆盖错误路径（502/503/504）

#### systemd hardening 完整化
- 加 `MemoryDenyWriteExecute` / `RestrictAddressFamilies`
- 加 `SystemCallFilter` 白名单
- 加 `CapabilityBoundingSet` 空集

### v1.0.0 — 工业级 ⚪

- 公开发布公告
- 完整文档（FAQ、TROUBLESHOOTING、ARCHITECTURE）
- Homebrew / deb 包（覆盖 Debian/Ubuntu）
- Docker 镜像
- Prometheus `/metrics` 端点
- 真实厂商 E2E 测试套件

---

## 明确不做 ❌

| 功能 | 原因 |
|---|---|
| Web UI | 用户明确不要 |
| 故障转移 / 熔断器 | 个人使用 + 1-2 厂商，不需要 |
| 反向协议转换 (OpenAI→Anthropic) | 用例不存在 |
| 多用户 / 计费 | 单机单用户，过设计 |
| Codex 适配 | 直接配 `OPENAI_BASE_URL` 即可 |
| 复杂整流器 | 厂商在逐渐兼容 Anthropic 协议 |
| 桌面 GUI 集成 | 反向诉求 |

---

## 评审报告

完整工业级评审见 [`docs/REVIEW.md`](./REVIEW.md)（v0.2.0 时生成）。

**当前评分（v0.3.0 后）**:
- P0 剩余: 2 项（P0-3 流式断流，P0-4 原子化） → v0.4.0 解决
- P1 剩余: 4 项（其中 P1-2 流式状态机建议优先）
- P2 剩余: 2 项（可延后）

**架构评分**:
- 分层、类型系统、依赖最少、部署简单: ✅
- 错误处理、可观测性、可扩展性: 仍弱

---

## 提交规范

每个版本发布时：
1. 跑全部测试（`bun test`）
2. 跑 typecheck（`bun run typecheck`）
3. 跑 smoke test（`bash scripts/smoke-test.sh`）
4. commit + tag + push
5. CI 自动构建 RPM + 创建 release

---

## 时间线

| 版本 | 发布日期 | 关键变更 |
|---|---|---|
| v0.1.0 | 2026-06-27 | 协议转换 + systemd + RPM |
| v0.2.0 | 2026-06-27 | provider use 自动切换 |
| v0.3.0 | 2026-06-29 | SQLite + 加密 |
| v0.4.0 | 2026-06-29 | P0-3 流式断流恢复 |
| v0.4.1 | 2026-06-29 | P0-4 事务化 provider use |
| v0.4.2 | 2026-06-29 | JSON5 兼容的 settings.json 合并 |
| v0.4.3 | 2026-06-29 | P1-2 流式工具调用状态机 |
| v0.4.4 | 2026-06-29 | P1-4 /stats 端点 |
| v0.5.0 | 2026-06-29 | P2-1 zod + P2-2 集成测试 + lint |
| v0.6.0 | 待定 | 厂商预设（MiniMax / DeepSeek / Kimi） |
| v1.0.0 | 待定 | 工业级 + 多发行版 |

---

## 如何贡献

当前是个人项目，但欢迎：
- 报告 bug（GitHub Issues）
- 提交厂商预设的 PR（preset 目录）
- 改进文档
- 添加测试用例

**代码风格**:
- TypeScript strict mode
- bun test 格式
- 单一职责函数
- 写中文注释（项目母语）

---

## 下一步行动（推荐顺序）

### ✅ 已完成到 v0.5.0

- v0.1.0 - v0.4.4 + v0.5.0 共 9 个版本
- 123/123 测试通过
- TypeScript strict + zod + biome lint
- 完整文档（README + REVIEW + ROADMAP + COMPARISON + AGENTS）
- systemd + RPM + GitHub Actions CI

### 🟡 推荐下一步（v0.6.0）

按优先级：

1. **去 AlmaLinux 9.7 真实验证**所有 v0.4.x 修复
   - provider use 原子化（switch provider 不卡）
   - 流式断流（连接 DeepSeek 跑长对话）
   - 工具调用（让 Claude Code 读文件）
   - /stats 端点（看 metrics）

2. **v0.6.0 厂商预设**（如果验证 OK 后）
   - 添加 `provider add --preset deepseek/kimi/minimax`
   - 自动填 base_url、wire_api、默认模型
   - 文档化每个厂商的 quirks

### ⚪ 未来路线（不需要现在）

- v0.7.0：覆盖率提升 + 系统安全 hardening
- v1.0.0：公网部署支持 + 多发行版 + 完整文档
3. **下周**: P0-4 + P1-2
4. **月底**: 发 v0.4.0
5. **未来**: 视使用情况决定 v0.5.0 优先级
