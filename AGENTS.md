# AGENTS.md - 项目约束与协作规范

**目标读者**: 任何接手本项目的 AI 助手（Claude、Cursor、Copilot 等）和人类开发者。

**目的**: 让协作者**立即理解项目边界**、**不浪费时间摸索**、**避免写出"AI 味道"代码**。

---

## 1. 项目本质（一句话）

**Linux 下的本地 HTTP 协议桥**：把 Claude Code 发的 Anthropic 协议请求，翻译成 OpenAI Chat Completions，转发给国内大模型厂商。

**不是**框架、平台、SaaS、桌面应用。

---

## 2. 范围（强约束）

### ✅ 这个项目**做**什么

| 维度 | 范围 |
|---|---|
| 方向 | **Anthropic → OpenAI 单向** |
| 应用 | Claude Code（Anthropic 协议）+ Codex CLI（直接配 env 即可，**不在本项目**） |
| 厂商 | 1-2 个国内厂商（典型：MiniMax、阿里通义、火山方舟） |
| 平台 | Linux 服务器（AlmaLinux / RHEL / Rocky / Fedora），systemd |
| 部署 | `.rpm` 包 + systemd service + 单二进制 |

### ❌ 这个项目**不做**什么

- ❌ **Web UI**（明确否决过）
- ❌ **反向转换**（OpenAI → Anthropic）— 没人用
- ❌ **故障转移 / 熔断器 / 复杂容灾** — 个人使用，1-2 厂商
- ❌ **thinking blocks 整流器** — 厂商在逐渐兼容 Anthropic 协议
- ❌ **多用户 / 计费** — 单机单用户
- ❌ **Codex CLI 适配** — 直接配 `OPENAI_BASE_URL` env 即可
- ❌ **桌面 GUI** — 反向诉求（用户在无桌面服务器上）
- ❌ **公网服务** — 默认监听 127.0.0.1

**遇到上述"诱惑功能"时**：在 PR/issue 里**明确拒绝**并引用本节。

---

## 3. 技术栈（不要替换）

| 维度 | 选择 | 不要换成 |
|---|---|---|
| 语言 | **TypeScript** (strict mode) | ❌ Rust / Go / Python（会失去跨平台零依赖优势） |
| 运行时 | **Bun** | ❌ Node.js（失去 `bun:sqlite`、`bun build --compile`） |
| HTTP | **Fastify 5** | ❌ Express / hapi（性能 / 生态考量） |
| SQLite | **bun:sqlite** (内建) | ❌ better-sqlite3（增加 ~3MB 依赖） |
| 加密 | **Web Crypto API** | ❌ node:crypto（兼容性） |
| CLI | **commander.js** | ❌ yargs（API 不一致） |
| 配置 | **YAML (js-yaml)** 仅用于示例 | ❌ TOML / JSON（保持简洁） |
| 存储 | **SQLite (AES-256-GCM)** | ❌ 纯文件 / Redis（复杂化） |
| 日志 | **pino + pino-pretty** | ❌ winston / bunyan |
| 测试 | **bun test** | ❌ vitest / jest（多一份工具链） |
| 打包 | **bun build --compile → RPM** | ❌ Docker（用户已明确要 RPM） |
| 目标发行版 | **dnf 系 (AlmaLinux/RHEL/Rocky/Fedora)** | ❌ Debian/Ubuntu（v1.0 前不投入） |

**理由**：每个选择都是基于"轻量、稳定、零依赖"。**不要为了新潮换技术**。

---

## 4. 代码规范

### 4.1 命名

- **文件名**: `kebab-case.ts`（如 `claude-config.ts`）
- **类/类型**: `PascalCase`
- **函数/变量**: `camelCase`
- **常量**: `UPPER_SNAKE_CASE`（仅当是真常量）
- **数据库表/字段**: `snake_case`（SQL 惯例）

### 4.2 注释

- **写中文注释**（项目母语，README 也是中文）
- 注释解释**为什么**，不是**是什么**
- 关键模块顶部写一段"本模块做什么"

```typescript
// 不好
// 计算总和
const sum = a + b;

// 好
// 用减法而不是 || 处理空值：避免 0 被当作空
const value = opts.foo ?? defaultValue;
```

### 4.3 函数组织

- **单一职责**: 一个函数只做一件事
- **长度**: 超过 50 行的函数应该拆
- **参数**: 超过 4 个参数考虑用对象
- **错误处理**: 用 `throw new Error("...")` 或自定义 Error 子类（如 `UpstreamError`）

### 4.4 TypeScript 严格度

- 启用 `strict: true`
- 不用 `any`（用 `unknown` 替代）
- 公开 API 必须有类型签名
- 内部模块可以用 `// @ts-expect-error` 注释说明原因

### 4.5 错误处理原则

- **不要静默吞错**（`catch {}` ❌）
- 错误消息包含**上下文**（URL、status、provider ID）
- 区分 **fatal**（直接抛出）和 **recoverable**（降级 / 重试）
- 重要错误必须 log 出来

```typescript
// 不好
try { ... } catch (e) {}

// 好
try { ... } catch (e) {
  logger.error({ err, url, providerId }, "upstream request failed");
  throw new UpstreamError(502, e.message, url);
}
```

---

## 5. 测试规范

### 5.1 必须测试

- ✅ 协议转换的所有边界情况（多模态、tool_use、tool_result、system 字符串/数组）
- ✅ 加密/解密往返
- ✅ CLI 命令（用 `Bun.spawn` 或直接调函数）
- ✅ 配置文件读写（保留 mcpServers 等用户字段）

### 5.2 测试命名

- 文件: `test/<module>.test.ts`
- describe: 模块名
- test: 行为描述（不要 `test 1` / `test works`）

### 5.3 测试隔离

- **每个测试用全新临时目录**（`Date.now() + counter`）
- **afterEach 必须 _resetForTests()**（关 DB）
- Windows: rm 用 try-catch 包裹（EBUSY）

### 5.4 不要写

- ❌ 跨测试共享全局状态
- ❌ 依赖网络（除非 mock）
- ❌ `setTimeout` 等真实时间（用 `mock`）

---

## 6. 提交规范

### 6.1 Commit message

格式：
```
<type>: <short summary>

<详细说明>

<footer>
```

**type**:
- `feat`: 新功能
- `fix`: bug 修复
- `refactor`: 重构（不改变行为）
- `docs`: 文档
- `test`: 测试
- `chore`: 杂项（CI / 依赖 / 配置）

**示例**:
```
feat: replace YAML with SQLite + AES-256-GCM encrypted API keys

Resolves P0-1 from docs/REVIEW.md: API key was stored in plaintext
YAML. Any process able to read the config could exfiltrate
provider credentials.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

### 6.2 提交前必须跑

```bash
bun test           # 全部通过
bun run typecheck  # 无错误
bash scripts/smoke-test.sh  # 烟雾测试通过
```

### 6.3 发布流程

1. 在 `main` 分支累计若干 commit
2. 跑全部测试 + typecheck
3. `git tag v0.x.0` + `git push origin main --tags`（用 `--tags` 而不是单独 push tag）
4. CI 自动 build RPM + 创建 release
5. 验证 release 里 .rpm 文件可下载

**不要**：
- ❌ 不在主分支直接改 bin
- ❌ 不绕过 CI 手动发 release
- ❌ 不在 release 之前 push tag

---

## 7. 文档规范

| 文档 | 用途 | 何时更新 |
|---|---|---|
| `README.md` | 用户文档 | 任何用户可见的改动 |
| `docs/REVIEW.md` | 工业级评审 | 重大重构后 |
| `docs/ROADMAP.md` | 路线图 | 发版后 |
| `AGENTS.md`（本文件） | AI 协作规范 | 工具链/规范变化时 |
| 源码注释 | 设计决策 | 写代码时 |

**不在** README 里：
- ❌ emoji 装饰
- ❌ "我们相信..." 营销话术
- ❌ 未来路线（用 ROADMAP.md）

---

## 8. 安全约束（强约束）

### 8.1 API key 处理

- ❌ **绝不**在源码里硬编码任何 key
- ❌ **绝不**把 key 写到日志
- ❌ **绝不**让 key 出现在 `ps aux` / 错误堆栈 / HTTP 响应里
- ✅ 所有 key **必须**经过 AES-256-GCM 加密后存 DB
- ✅ 调试时用 `redact` / `***` 屏蔽

### 8.2 默认监听地址

- ✅ 默认 `127.0.0.1`
- ⚠️ 如果用户改成 `0.0.0.0`，**必须打印警告**
- ❌ 不要默认暴露公网

### 8.3 文件权限

- DB 文件 0o600
- master.key 0o600
- 不要用更宽松的权限

---

## 9. 性能约束

| 维度 | 目标 |
|---|---|
| 启动时间 | < 100ms |
| 协议转换开销 | < 1ms（单请求） |
| 内存占用 | < 50MB（空闲时） |
| 二进制大小 | < 35MB |
| 流式首字延迟 | < 50ms（仅代理开销） |

**不要**：
- ❌ 引入运行时优化（如缓存层、连接池），除非**先有 profile 证据**
- ❌ 添加 Prometheus client / OpenTelemetry（v0.5 之前不引入）
- ❌ 用 N-API / Rust FFI（失去跨平台编译能力）

---

## 10. 评审报告引用

完整工业级评审见 [`docs/REVIEW.md`](./REVIEW.md)。**P0 问题必须在下个版本修复**，P1 在两个版本内修复。

每次发版后**更新**：
- `docs/ROADMAP.md` 的"时间线"表
- `docs/REVIEW.md` 中已修复项的状态

---

## 11. 沟通规范

### 11.1 中文优先

- **代码注释**: 中文
- **commit message**: 中文（除 Co-Authored-By 外）
- **issue / PR**: 中文
- **release notes**: 中文

### 11.2 文档输出格式

- 用 markdown 表格
- 状态用 emoji（✅ 🟡 ⚪ ❌）
- 引用文件用 `path:line`（如 `src/cli.ts:42`）

### 11.3 决策记录

重大决策（架构、安全、依赖）应该在 `docs/` 下写 ADR（Architecture Decision Record）：

```
docs/adr/0001-use-bun.md
docs/adr/0002-sqlite-with-encryption.md
```

格式：
- **状态**: 提议 / 通过 / 弃用
- **背景**: 什么问题
- **决策**: 选择了什么
- **理由**: 为什么
- **影响**: 后果

---

## 12. 常见陷阱（来自历史 PR）

### 12.1 不要新增 npm 依赖

- 任何新依赖 → 必须有强理由
- 优先用 Bun 内建 / Node 内建
- 引入前先看 `node_modules` 现在的 size

### 12.2 不要破坏 Windows 兼容性

CI 在 GitHub Actions（ubuntu）跑，但**开发者在 Windows**（项目用 WSL / Git Bash）。
- 文件路径用 `path.join` / `node:path`
- 测试用 `try-catch` 包裹 Windows-only 错误（EBUSY）
- chmod 不依赖 Unix bit（Windows 会映射）

### 12.3 不要用 `bun` 特性除非是必须的

- ✅ 用 `Bun.spawn`, `Bun.file`, `bun:sqlite`
- ⚠️ `Bun.env`（有时 Win 有问题）
- ❌ 避免 `Bun.serve`（用 Fastify 保持可移植性）
- ❌ 避免 `bunfig.toml`（影响 CI 行为）

### 12.4 不要在 PR 里加 emoji

commit message 里**不**要 emoji。文档里可以用。

---

## 13. 如何贡献

### 13.1 报告 bug

1. 跑 `bun test` + `bun run typecheck`，附输出
2. 操作系统、bun 版本
3. 复现步骤
4. 期望 vs 实际

### 13.2 提交 PR

1. fork 仓库
2. 在新分支开发
3. 跑全部测试
4. commit 用规范格式
5. PR 描述说明动机 + 改动 + 测试
6. **不要直接改 main**

### 13.3 提交厂商预设

每个厂商一个文件 `src/providers/presets/<vendor>.ts`：
- 暴露 base_url 默认值
- 默认模型映射
- 特殊处理（如 1M context）

---

## 14. 快速参考

### 项目结构
```
cc-switch-protocol-bridge/
├── src/
│   ├── cli.ts              # CLI 入口 (commander)
│   ├── server.ts           # Fastify HTTP
│   ├── config.ts           # 配置层 (DB 适配)
│   ├── claude-config.ts    # ~/.claude/settings.json 管理
│   ├── logger.ts           # pino
│   ├── types.ts            # 共享类型
│   ├── converter/          # 协议转换
│   │   ├── anthropic-to-openai.ts
│   │   └── streaming.ts
│   ├── providers/          # 上游 HTTP
│   │   └── client.ts
│   └── store/              # SQLite + 加密
│       └── db.ts
├── test/                   # bun test
├── docs/                   # REVIEW, ROADMAP
├── packaging/              # RPM / systemd
├── scripts/                # smoke-test.sh
└── .github/workflows/      # CI
```

### 关键文件行数
- 全部 TS 源码: ~1300 行
- 测试: ~600 行
- 文档: ~600 行

### 跑测试
```bash
bun test                  # 单元 + E2E
bun run typecheck         # TS 类型
bash scripts/smoke-test.sh  # 端到端
```

### 调试
```bash
# 启用 debug 日志
LOG_LEVEL=debug bun run src/cli.ts serve

# 直接看 DB
sqlite3 /var/lib/cc-switch/cc-switch.db
sqlite> .tables
sqlite> SELECT id, vendor FROM providers;
sqlite> SELECT provider_id, substr(encrypted_api_key, 1, 30) FROM provider_secrets;
```

---

## 15. 致新协作者

**项目处于 v0.3.0（已发布 3 个版本）**，正在向 v1.0（工业级）演进。

- **想加新功能？** 先看 ROADMAP.md，避免范围蔓延
- **想修 bug？** 看 REVIEW.md 的 P0/P1 列表
- **想重构？** 开 issue 讨论，避免直接动核心代码
- **想了解架构？** 看 ROADMAP.md "结构" + REVIEW.md "架构评审"

**最重要的约束**：**不要引入范围蔓延**。每个 PR 应该**单一目的**。

---

**最后更新**: 2026-06-29
**维护者**: sszhu-8bit
**许可证**: MIT
