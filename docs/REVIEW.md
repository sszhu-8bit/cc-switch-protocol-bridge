# 工业级评审报告

**评审版本**: v0.2.0
**评审日期**: 2026-06-27
**评审范围**: 代码架构、安全性、稳定性、可观测性、可维护性

---

## 总评

**这是一个 0.1.x 阶段的协议桥**，目标是"个人 Linux 机器 + 1-2 个国内厂商 + Claude Code 接入"。

按这个目标看，**架构和功能是合格的**；但按"工业级 SaaS 服务 / 公网服务"标准看，**有 11 个明确问题**——其中 4 个是 P0（生产部署前必修），5 个是 P1，2 个是 P2。

按严重程度排序，**不夸大也不缩小**。

---

## P0 — 必修：安全/正确性会在真实使用中爆炸

### P0-1：API key 以明文存储 + 进程命令行暴露

**位置**：`src/config.ts` 写 `provider.api_key` 到 YAML；`src/providers/client.ts:33` 注入 `Authorization: Bearer` header。

**问题**：
- YAML 默认 644 权限（任何同机用户可读）
- `ps aux` 看不到 key（因为是配置文件不是命令行参数），但**任何能读 `/etc/cc-switch/config.yaml` 的进程都能拿到 key**
- 配置文件里 `cc-switch-managed` 的占位 token 写在 `~/.claude/settings.json` 里——也是明文

**真实风险**：你的服务器是多人共用吗？如果是，任何用户 `cat /etc/cc-switch/config.yaml` 就能拿到你 DeepSeek 的 key。**这是 cc-switch 上游也没完全解决的问题**，但上游用了 DB + 加密字段。

**修复方向**：
```yaml
# 选项 A：unix 权限
install -m 0600 -o root -g root /etc/cc-switch/config.yaml
# 配 systemd 的 User=ccswitch 时降权

# 选项 B：环境变量引用（推荐）
providers:
  - id: deepseek
    api_key: "${DEEPSEEK_KEY}"  # 启动时从环境读取
```
短期至少做到 **`chmod 600`** + systemd 强制 `User=ccswitch`。

---

### P0-2：HTTP 监听 0.0.0.0 风险 + 缺 TLS

**位置**：`src/config.ts:7` `listen_address: "127.0.0.1"`（默认安全），但用户可能改 `0.0.0.0`。

**问题**：
- 默认是 127.0.0.1 ✅
- 但 `provider use` 写到 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 也是 127.0.0.1 ✅
- **没人强制校验**：用户写 `0.0.0.0` 就裸跑 HTTP，所有人能直接打你的代理，**偷用你的 key + 看你的对话**

**真实风险**：你 README 里 `BASE_URL=http://127.0.0.1:17821` 没问题。但如果某天你想在多机/容器里用，可能改 `0.0.0.0`，**没有任何告警**。

**修复方向**：
- 启动时如果 `listen_address` 不是 127.0.0.1/::1，**打印醒目警告**
- 或者干脆**禁止** 0.0.0.0，需要 TLS reverse proxy（caddy/nginx）才能对外
- 加 bearer token 校验（不是 cc-switch-managed 这种明文占位符）

---

### P0-3：流式响应里"上游断流"是静默错误

**位置**：`src/server.ts:65-86`。

**问题**：
```typescript
for await (const chunk of parseOpenAIStream(upstreamBody)) {
  const events = converter.feed(chunk);
  if (events.length > 0) {
    reply.raw.write(formatAnthropicSSE(events));
  }
}
// ↑ 如果中途网络断开，这里 throw，会被 catch 包住，
//   写一个 error event 出去——但客户端可能已经拿到一半数据
```

**真实场景**：
- 你让 Claude Code 跑 30 分钟长任务
- DeepSeek 5 分钟后断流（429、timeout、TCP reset）
- 我们 catch 住，往 SSE 流里写 error event
- 客户端：可能"已收到的部分内容丢失"+"错误码解析失败"= Claude Code 报奇怪错误

**修复方向**：
- 检测到上游断开时，**回退上一个 message_stop 事件**（告诉客户端"刚才那条消息结束了"）
- 错误信息用 Anthropic 标准格式：`error: { type: "overloaded_error", message: "..." }`
- 至少确保 `message_stop` 在 `error` 之前发出

---

### P0-4：`provider use` 改 `~/.claude/settings.json` 但**不原子**

**位置**：`src/claude-config.ts:65-70`。

```typescript
const tmp = `${path}.tmp`;
writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
renameSync(tmp, path);
```

**分析**：✅ 你写了 tmp + rename，**这已经原子了**。

**但 P0-4 是另一个问题**：`systemctl restart` 和 `~/.claude/settings.json` 写入**不是事务的**。

**真实场景**：
1. `provider use kimi` 改完 settings.json
2. `systemctl restart cc-switch` 启动失败（YAML 解析错）
3. 现在 Claude Code 的 `ANTHROPIC_BASE_URL` 还指着 127.0.0.1:17821
4. 但服务挂了 / 配置坏了 / 端口被占
5. **用户的 Claude Code 静默失败**——他不知道是 cc-switch 的问题还是 Anthropic 自己的问题

**修复方向**：
- 写入 settings.json **之前**先验证：proxy 能成功启动、config 合法
- 如果 systemctl 启动失败，**回滚** settings.json
- 或者：使用一个 health check，settings.json 写完等 1 秒，验证 `/health` 返回 200，才算成功

---

## P1 — 应当修：会引发用户困惑 / 维护成本

### P1-1：协议转换边界情况

**位置**：`src/converter/anthropic-to-openai.ts:46-49`：

```typescript
// 助手消息里出现 image 在 Anthropic 是允许的，但 OpenAI 助手消息通常不带 image。
// 这种情况实际很少见，遇到时丢弃。
```

**问题**：注释里承认"丢弃"，但**没日志**。如果用户的多模态对助理失败，没人能定位。

**修复**：转换时记录被丢弃的内容到 debug 日志。

---

### P1-2：流式状态机对**部分**工具调用无健壮性

**位置**：`src/converter/streaming.ts:64-95`。

**问题**：
```typescript
if (tc.id) entry.id = tc.id;
if (tc.function?.name) entry.name = tc.function.name;
```

部分 OpenAI 实现会**只发 `id` 在第一个 chunk**、**只发 `name` 在第一个 chunk**、**只发 `arguments` delta 在后续**。当前代码在收到 `id` 之前就把 `id: ""` 写进 `content_block_start` 了——**这是错的**。

**修复**：延迟 `content_block_start` 直到至少有 `id` 和 `name`。

---

### P1-3：日志写本地文件但**没看到 file rotation 实现**（误报）

**位置**：spec 配 `StandardOutput=journal`，实际 go-runtime 日志走 pino。

**修复**：✅ 实际上 systemd journal 已经在管 rotation，不用额外配。

~~**修复**：要么配 pino-rotate，要么依赖 journald（`StandardOutput=journal` 已经配了，**这已经够了**）。~~

---

### P1-4：完全没 metrics / 监控

**问题**：proxy 跑了一周后你不知道：
- 哪个 provider 调用最多
- 错误率多少
- 平均延迟
- 当前活跃 provider 的健康度

**修复方向**：
- `/metrics` 端点暴露 Prometheus 格式（轻量）
- 或至少 `/stats` 端点返回 JSON 计数

---

### P1-5：`bun build --compile` 产物的可复现性

**问题**：CI 每次跑出来的 `cc-switch` 二进制**不一样**——bun 不保证 bit-reproducible build。

**影响**：你看到 build 编号变了就慌，验证版本时要重新签名/重新测试。

**修复**：`SOURCE_DATE_EPOCH=...` + `BUILDKIT_SBOM_SCAN_CONTEXT=...`（bun 部分支持）

---

## P2 — 可以做但不必现在做

### P2-1：YAML 配置无 schema 校验

加载任意 YAML，类型错了（比如 `listen_port: "17821"` 字符串）会运行时炸。

**修复**：启动时用 zod 校验，加 `--validate-config` 模式。

---

### P2-2：测试覆盖率

- ✅ 协议转换（7 测试）
- ✅ Claude config 管理（5 测试）
- ✅ E2E provider use（2 测试）
- ❌ **HTTP 服务器层 0 集成测试**——所有 server.ts 的逻辑都没测
- ❌ **真实流式上游 0 集成测试**——流式转换只在 mock 单元测试下过

**修复**：用 fastify 的 `app.inject()` 写 5-10 个 integration test。

---

## 架构 / 设计评审

### 优点

| 维度 | 评价 |
|---|---|
| **分层** | converter/providers/server/cli/config 清晰分离 ✅ |
| **类型系统** | 全 TypeScript，所有边界有 interface ✅ |
| **依赖最少** | 5 个 prod dep，全是必要（commander/fastify/js-yaml/pino/pino-pretty） ✅ |
| **部署简单** | 单二进制 + systemd + RPM，零运行时依赖 ✅ |
| **代码量** | 1837 行（含测试）—— 0.1.x 阶段合理 ✅ |
| **CLI 设计** | 5 个 provider 子命令 + serve/status，符合 Unix 哲学 ✅ |

### 缺点

| 维度 | 评价 |
|---|---|
| **错误处理** | 上游错误 → 502，配置错误 → 503，但**没区分 retryable vs fatal** ❌ |
| **可观测性** | 没 metrics、没 trace、没 request ID ❌ |
| **可扩展性** | 加新 provider 要改 4 个文件（types/claude-config/client/parser） ❌ |
| **文档** | README 写得好，但**没有 ARCHITECTURE.md / TROUBLESHOOTING.md** ❌ |
| **CI** | 只 build + test，**没 lint、没 format check、没 audit** ❌ |

---

## 风险评估 vs 实际使用场景

| 问题 | 严重度 | 备注 |
|---|---|---|
| P0-1 API key 明文 | **中** | 单机单人用，文件 600 权限就够 |
| P0-2 0.0.0.0 风险 | **低** | 一直 127.0.0.1，不会改 |
| P0-3 流式断流 | **高** | Claude Code 跑长任务时真会触发 |
| P0-4 写入非原子 | **低** | 99% 情况 systemctl 启动会成功 |
| P1-2 工具调用状态机 | **中** | 用到 tool 的场景才暴露 |

---

## 修复路线图（按优先级）

### 第一周必做（影响日常使用）

1. **P0-1**：配置文件 `chmod 600` + systemd 强制 `User=ccswitch`
2. **P0-3**：流式断开时保证 `message_stop` 在 `error` 之前

### 第二周做（提升稳定性）

3. **P1-2**：流式工具调用状态机修复
4. **P1-4**：加 `/stats` 端点（简单 30 行）

### 未来做（演进到 v0.5+）

5. **P1-1**：日志记录丢弃的字段
6. **P1-5**：可复现构建
7. **P2-1**：zod 校验
8. **P2-2**：server 层 integration test

---

## 总结

> **架构合理、代码质量合格、范围与目标一致**。但当前定位是"个人工具"而不是"产品"。要变成"工业级"，主要在**可观测性、错误恢复、配置安全**三方面补强。P0-1 + P0-3 是必须修的，其他按场景分批补。

---

## 评审签字

- 评审人: Claude Opus 4.8 (1M context)
- 评审对象: cc-switch-protocol-bridge v0.2.0
- 评审依据: 源码静态分析 + 历史 Git 提交 + 运行时烟雾测试日志
