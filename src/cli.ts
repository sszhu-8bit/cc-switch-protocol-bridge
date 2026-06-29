#!/usr/bin/env node
// CLI 入口

import { Command } from "commander";
import { existsSync } from "node:fs";
import { loadConfig, saveConfig, getProvider } from "./config.js";
import {
  deleteProvider,
  getCurrentProviderId,
  getDb,
  getMasterKey,
  listProviders,
  saveProvider as dbSaveProvider,
  setCurrentProvider,
  setSetting,
  DEFAULT_DB_PATH,
} from "./store/db.js";
import { startServer } from "./server.js";
import { logger } from "./logger.js";
import {
  buildClaudeSettings,
  writeClaudeSettings,
  readClaudeSettingsRaw,
  restoreClaudeSettings,
} from "./claude-config.js";
import type { ProviderConfig } from "./types.js";

const program = new Command();

program
  .name("cc-switch")
  .description("Lightweight Anthropic ↔ OpenAI protocol bridge for Linux servers")
  .version("0.3.0");

// === Root flags ===
program
  .option(
    "--db <path>",
    "SQLite database path",
    process.env["CC_SWITCH_DB"] ?? DEFAULT_DB_PATH
  );

// === serve ===
program
  .command("serve")
  .description("Start the protocol bridge server (foreground)")
  .option("--listen-address <addr>", "Override listen address")
  .option("--listen-port <port>", "Override listen port")
  .action(async (opts) => {
    const config = await loadConfig();
    if (opts.listenAddress) config.listen_address = opts.listenAddress;
    if (opts.listenPort) config.listen_port = parseInt(opts.listenPort, 10);
    if (!config.current_provider || config.providers.length === 0) {
      logger.error(
        "no provider configured. Run `cc-switch provider add` first."
      );
      process.exit(1);
    }
    await startServer(config);
  });

// === status ===
program
  .command("status")
  .description("Show current configuration and provider status")
  .action(async () => {
    const config = await loadConfig();
    const current = config.current_provider
      ? await getProvider(config, config.current_provider)
      : undefined;
    console.log("=== cc-switch status ===");
    console.log(`Listen: ${config.listen_address}:${config.listen_port}`);
    console.log(`Current provider: ${current?.id ?? "(none)"}`);
    if (current) {
      console.log(`  Name: ${current.name}`);
      console.log(`  Vendor: ${current.vendor}`);
      console.log(`  Base URL: ${current.base_url}`);
      console.log(`  Models:`);
      if (current.models.sonnet) console.log(`    sonnet -> ${current.models.sonnet}`);
      if (current.models.opus) console.log(`    opus -> ${current.models.opus}`);
      if (current.models.haiku) console.log(`    haiku -> ${current.models.haiku}`);
    }
    console.log(`\nConfigured providers (${config.providers.length}):`);
    for (const p of config.providers) {
      const mark = p.id === config.current_provider ? "*" : " ";
      console.log(`  ${mark} ${p.id} (${p.name}) - ${p.vendor}`);
    }
  });

// === provider 子命令 ===
const providerCmd = program.command("provider").description("Manage LLM providers");

providerCmd
  .command("list")
  .description("List all configured providers")
  .action(async () => {
    const config = await loadConfig();
    console.log("Configured providers:");
    for (const p of config.providers) {
      const mark = p.id === config.current_provider ? "*" : " ";
      console.log(`  ${mark} ${p.id} (${p.name}) - ${p.vendor} - ${p.base_url}`);
    }
    if (config.providers.length === 0) {
      console.log("  (none)");
    }
  });

providerCmd
  .command("add")
  .description("Add a new provider")
  .requiredOption("--id <id>", "Provider ID")
  .requiredOption("--name <name>", "Display name")
  .requiredOption("--vendor <vendor>", "Vendor: minimax | openai-compatible")
  .requiredOption("--base-url <url>", "OpenAI-compatible API base URL")
  .requiredOption("--api-key <key>", "API key (will be encrypted in DB)")
  .option("--sonnet-model <model>", "Model name for sonnet role")
  .option("--opus-model <model>", "Model name for opus role")
  .option("--haiku-model <model>", "Model name for haiku model")
  .action(async (opts) => {
    const existing = await getProvider(await loadConfig(), opts.id);
    if (existing) {
      console.error(`Provider '${opts.id}' already exists`);
      process.exit(1);
    }
    const provider: ProviderConfig = {
      id: opts.id,
      name: opts.name,
      vendor: opts.vendor as ProviderConfig["vendor"],
      base_url: opts.baseUrl,
      api_key: opts.apiKey,
      models: {
        sonnet: opts.sonnetModel,
        opus: opts.opusModel,
        haiku: opts.haikuModel,
      },
    };
    await dbSaveProvider(provider);
    if (!getCurrentProviderId()) {
      setCurrentProvider(opts.id);
      console.log(`Set '${opts.id}' as current provider`);
    }
    console.log(`✓ Provider '${opts.id}' added (api_key encrypted)`);
  });

providerCmd
  .command("remove")
  .description("Remove a provider")
  .argument("<id>", "Provider ID")
  .action(async (id) => {
    const ok = await deleteProvider(id);
    if (!ok) {
      console.error(`Provider '${id}' not found`);
      process.exit(1);
    }
    if (getCurrentProviderId() === id) {
      const remaining = await listProviders();
      setCurrentProvider(remaining[0]?.id ?? "");
      console.log(`Current provider reset to '${remaining[0]?.id ?? ""}'`);
    }
    console.log(`✓ Provider '${id}' removed`);
  });

// 切换当前 provider + 自动写 ~/.claude/settings.json + 重启 systemd 服务
// P0-4: 事务式执行，失败时回滚到原状态
providerCmd
  .command("use")
  .description(
    "Switch the active provider. Updates cc-switch DB, rewrites ~/.claude/settings.json, and restarts the cc-switch systemd service. Transactional: rolls back on failure."
  )
  .argument("<id>", "Provider ID to activate")
  .option(
    "--claude-settings <path>",
    "Claude Code settings.json path",
    (process.env["HOME"] ?? "") + "/.claude/settings.json"
  )
  .option("--no-restart", "Don't restart systemd service")
  .option("--no-write-claude", "Skip writing ~/.claude/settings.json")
  .action(async (id, opts) => {
    const config = await loadConfig();
    const provider = await getProvider(config, id);
    if (!provider) {
      console.error(`Provider '${id}' not found. Run 'cc-switch provider list' to see available providers.`);
      process.exit(1);
    }

    // === P0-4 事务快照 ===
    // 在做任何修改前记录旧状态，用于失败时回滚
    const oldProviderId = getCurrentProviderId();
    const oldClaudeSettingsRaw = opts.writeClaude
      ? readClaudeSettingsRaw(opts.claudeSettings)
      : null;

    let dbChanged = false;
    let settingsWritten = false;

    try {
      // 步骤 1: 改 DB
      setCurrentProvider(id);
      dbChanged = true;
      console.log(`✓ Set '${id}' as current provider in DB`);

      // 步骤 2: 改 ~/.claude/settings.json
      if (opts.writeClaude) {
        const proxyBaseUrl = `http://${config.listen_address}:${config.listen_port}`;
        const settings = buildClaudeSettings(provider, proxyBaseUrl);
        writeClaudeSettings(opts.claudeSettings, settings);
        settingsWritten = true;
        console.log(`✓ Updated ${opts.claudeSettings} (BASE_URL=${proxyBaseUrl})`);
      }

      // 步骤 3: 重启 systemd 服务
      if (opts.restart) {
        if (!existsSync("/run/systemd/system")) {
          console.log(`⚠ systemd not detected. Restart the service manually:`);
          console.log(`    /usr/bin/cc-switch serve`);
        } else {
          const restartResult = await restartSystemdService();
          if (!restartResult.ok) {
            // 重启失败：抛出，由外层 catch 回滚
            throw new SwitchError(
              `systemctl restart failed (exit ${restartResult.exitCode ?? "?"}): ${restartResult.stderr ?? ""}`
            );
          }
          console.log(`✓ Restarted cc-switch.service`);

          // 步骤 4: 后置健康检查
          // 等 1 秒让 systemd 完全启动，然后 ping /health
          await new Promise((r) => setTimeout(r, 1000));
          const healthOk = await checkHealth(
            `http://${config.listen_address}:${config.listen_port}/health`
          );
          if (!healthOk) {
            throw new SwitchError(
              `Service started but /health did not return 200 within timeout. ` +
                `The proxy may be misconfigured or the port may be in use.`
            );
          }
          console.log(`✓ Health check passed`);
        }
      } else {
        console.log(`⚠ Skipped restart. Run: sudo systemctl restart cc-switch`);
      }
    } catch (err) {
      // === P0-4 回滚 ===
      console.error(
        `\n✗ Switch failed: ${err instanceof Error ? err.message : err}`
      );
      console.error(`  Rolling back...`);
      try {
        if (settingsWritten && oldClaudeSettingsRaw !== null) {
          restoreClaudeSettings(opts.claudeSettings, oldClaudeSettingsRaw);
          console.error(`  ✓ Restored ${opts.claudeSettings}`);
        } else if (settingsWritten && oldClaudeSettingsRaw === null) {
          // 旧文件不存在但现在写了 → 删除新建的（恢复"无"状态）
          try {
            const { unlinkSync } = await import("node:fs");
            unlinkSync(opts.claudeSettings);
            console.error(`  ✓ Removed new ${opts.claudeSettings}`);
          } catch {
            console.error(`  ⚠ Could not remove new ${opts.claudeSettings} (manual cleanup may be needed)`);
          }
        }
        if (dbChanged) {
          setCurrentProvider(oldProviderId);
          console.error(`  ✓ Restored current_provider='${oldProviderId}' in DB`);
        }
        // 如果已 systemctl restart 过，尝试再 restart 回到原 provider
        if (opts.restart && existsSync("/run/systemd/system") && oldProviderId) {
          console.error(`  Re-restarting service with old provider...`);
          const r = await restartSystemdService();
          if (r.ok) {
            console.error(`  ✓ Service re-restarted`);
          } else {
            console.error(`  ⚠ Failed to re-restart: ${r.stderr ?? "unknown"}`);
          }
        }
      } catch (rollbackErr) {
        console.error(
          `  ✗ Rollback FAILED: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`
        );
        console.error(`  Manual recovery may be required.`);
      }
      process.exit(1);
    }

    console.log(`\nNow using: ${provider.name} (${provider.vendor})`);
    console.log(`Models: sonnet -> ${provider.models.sonnet ?? "(default)"}, opus -> ${provider.models.opus ?? "(default)"}, haiku -> ${provider.models.haiku ?? "(default)"}`);
  });

/**
 * P0-4: 自定义错误类型（事务回滚触发条件）
 */
class SwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchError";
  }
}

/**
 * 异步执行 systemctl restart，返回结果（含 exit code / stderr）
 */
async function restartSystemdService(): Promise<{
  ok: boolean;
  exitCode: number | null;
  stderr: string | null;
}> {
  try {
    const proc = Bun.spawn(["systemctl", "restart", "cc-switch.service"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      exitCode,
      stderr: stderr || null,
    };
  } catch (e) {
    return {
      ok: false,
      exitCode: null,
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 健康检查：3 秒内重试 5 次
 */
async function checkHealth(url: string, maxAttempts = 5): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return true;
    } catch {
      /* retry */
    }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

// 交互式添加
providerCmd
  .command("add-interactive")
  .description("Interactively add a provider (prompts for fields)")
  .action(async () => {
    const question = (q: string): Promise<string> =>
      new Promise((resolve) => {
        process.stdout.write(q);
        process.stdin.once("data", (d) => resolve(d.toString().trim()));
      });

    console.log("=== Add provider interactively ===");
    const id = await question("Provider ID (lowercase, no spaces): ");
    const name = await question("Display name: ");
    const vendor = await question("Vendor (minimax/openai-compatible): ");
    const baseUrl = await question("Base URL: ");
    const apiKey = await question("API key: ");
    const sonnet = await question("Sonnet model (Enter to skip): ");
    const opus = await question("Opus model (Enter to skip): ");
    const haiku = await question("Haiku model (Enter to skip): ");

    const config = await loadConfig();
    if (await getProvider(config, id)) {
      console.error(`Provider '${id}' already exists`);
      process.exit(1);
    }
    const provider: ProviderConfig = {
      id,
      name,
      vendor: vendor as ProviderConfig["vendor"],
      base_url: baseUrl,
      api_key: apiKey,
      models: {
        sonnet: sonnet || undefined,
        opus: opus || undefined,
        haiku: haiku || undefined,
      },
    };
    await dbSaveProvider(provider);
    if (!getCurrentProviderId()) setCurrentProvider(id);
    console.log(`\n✓ Provider '${id}' added (api_key encrypted)`);
  });

// === key management 子命令 ===
const keyCmd = program.command("key").description("Manage master encryption key");

keyCmd
  .command("generate")
  .description("Generate a new 32-byte master key (hex) for AES-256-GCM")
  .action(() => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const hex = Buffer.from(key).toString("hex");
    console.log("Generated 32-byte master key (hex):");
    console.log(hex);
    console.log("");
    console.log("To use it:");
    console.log("  1. Save it to /etc/cc-switch/master.key");
    console.log("  2. chmod 600 /etc/cc-switch/master.key");
    console.log("  3. chown ccswitch:ccswitch /etc/cc-switch/master.key");
    console.log("");
    console.log("Or set CC_SWITCH_MASTER_KEY env var to this value.");
    console.log("⚠ KEEP THIS SECRET — losing it means losing access to encrypted API keys.");
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err }, "fatal error");
  process.exit(1);
});