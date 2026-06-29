# 开发路线图 (Roadmap)

**项目**: cc-switch-protocol-bridge
**仓库**: https://github.com/sszhu-8bit/cc-switch-protocol-bridge
**最后更新**: 2026-06-29

---

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

## v0.4.0 — 推荐下一个版本 🟡

**目标**: 修复评审报告 P0 剩余问题 + 提升稳定性

### 候选功能（按优先级）

#### P0-3: 流式断流恢复
**问题**: `src/server.ts:65-86` 中上游断开时只写 error event，客户端可能"已收部分内容丢失 + 错误码解析失败"。

**方案**:
- 检测到上游断开时，先发 `message_stop` 事件再发 `error` 事件
- 让 Claude Code 客户端知道"已收到的部分是完整的"
- 错误信息用 Anthropic 标准格式（`overloaded_error` / `upstream_unavailable`）

**预估**: ~100 行代码 + 3 个测试

#### P0-4: provider use 原子化
**问题**: 写 `~/.claude/settings.json` 和重启 systemd 不是事务。重启失败时 Claude Code 静默。

**方案**:
- 写入 settings.json **之前**先验证 systemd 启动成功
- 失败时回滚 settings.json
- 或者：写完 settings.json 等 1 秒，验证 `/health` 返回 200

**预估**: ~50 行 + 2 个测试

#### P1-2: 流式工具调用状态机健壮性
**问题**: `src/converter/streaming.ts:64-95` 中 `content_block_start` 在收到 `id` 之前就发出去了（`id: ""`）。

**方案**:
- 延迟 `content_block_start` 直到有完整的 `id` + `name`
- 处理 `tool_use` 中途切分的不规则 chunk

**预估**: ~50 行 + 4 个测试

#### P1-4: 简单 metrics 端点
**方案**: `/stats` 返回 JSON：
```json
{
  "uptime_seconds": 3600,
  "total_requests": 1234,
  "successful_requests": 1200,
  "failed_requests": 34,
  "current_provider": "deepseek",
  "provider_health": { "deepseek": "healthy", "kimi": "unhealthy" }
}
```

**预估**: ~80 行 + 2 个测试

### 建议组合
**v0.4.0** = P0-3 + P0-4 + P1-2 + P1-4 = ~280 行

预计 3-5 天工作量。

---

## v0.5.0 — 观察性与可维护性 ⚪

### 候选功能

#### P1-1: 协议转换边界日志
在 `src/converter/anthropic-to-openai.ts:46-49` 丢弃字段时记录 debug 日志。
- 预估: ~10 行

#### P1-5: 可复现构建
CI 加 `SOURCE_DATE_EPOCH=...`，使 RPM 文件名/内容稳定。
- 预估: 1 行 spec 改动

#### CI 增强
- 加 `biome` / `prettier` lint
- 加 `npm audit` / `bun audit`
- typecheck 跑在多 Node 版本

**预估**: 半周

#### 测试覆盖率提升
- HTTP 服务器层集成测试（用 `app.inject()`）
- 真实流式上游的 mock 测试
- 目标: 70% 覆盖率

**预估**: 1 周

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
| v0.4.0 | 待定 | P0-3, P0-4, P1-2, P1-4 |
| v0.5.0 | 待定 | 观察性 + 维护性 |
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

1. **现在** (今天): 安装 v0.3.0 到 AlmaLinux 9.7 验证加密流程
2. **本周**: 实现 v0.4.0 P0-3（流式断流恢复）
3. **下周**: P0-4 + P1-2
4. **月底**: 发 v0.4.0
5. **未来**: 视使用情况决定 v0.5.0 优先级
