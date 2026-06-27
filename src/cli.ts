#!/usr/bin/env node
// CLI 入口

import { Command } from "commander";
import { existsSync } from "node:fs";
import { loadConfig, saveConfig, getProvider } from "./config.js";
import { startServer } from "./server.js";
import { logger } from "./logger.js";
import { buildClaudeSettings, writeClaudeSettings } from "./claude-config.js";
import type { ProviderConfig } from "./types.js";

const program = new Command();

program
  .name("cc-switch")
  .description("Lightweight Anthropic ↔ OpenAI protocol bridge for Linux servers")
  .version("0.1.0");

// serve: 前台启动服务
program
  .command("serve")
  .description("Start the protocol bridge server (foreground)")
  .option("-c, --config <path>", "config file path", "/etc/cc-switch/config.yaml")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    if (!config.current_provider || config.providers.length === 0) {
      logger.error(
        { config_path: opts.config },
        "no provider configured. Run `cc-switch provider add` first."
      );
      process.exit(1);
    }
    await startServer(config);
  });

// status: 查看运行状态
program
  .command("status")
  .description("Show current configuration and provider status")
  .option("-c, --config <path>", "config file path", "/etc/cc-switch/config.yaml")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const current = config.current_provider
      ? getProvider(config, config.current_provider)
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

// provider 子命令组
const providerCmd = program.command("provider").description("Manage LLM providers");

providerCmd
  .command("list")
  .description("List all configured providers")
  .option("-c, --config <path>", "config file path", "/etc/cc-switch/config.yaml")
  .action((opts) => {
    const config = loadConfig(opts.config);
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
  .requiredOption("--id <id>", "Provider ID (used in CLI commands)")
  .requiredOption("--name <name>", "Display name")
  .requiredOption("--vendor <vendor>", "Vendor: minimax | openai-compatible")
  .requiredOption("--base-url <url>", "OpenAI-compatible API base URL")
  .requiredOption("--api-key <key>", "API key")
  .option("--sonnet-model <model>", "Model name for sonnet role")
  .option("--opus-model <model>", "Model name for opus role")
  .option("--haiku-model <model>", "Model name for haiku role")
  .option("-c, --config <path>", "config file path", "/etc/cc-switch/config.yaml")
  .action((opts) => {
    const config = loadConfig(opts.config);
    if (getProvider(config, opts.id)) {
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
    config.providers.push(provider);
    if (!config.current_provider) {
      config.current_provider = opts.id;
      console.log(`Set '${opts.id}' as current provider`);
    }
    saveConfig(config, opts.config);
    console.log(`Provider '${opts.id}' added to ${opts.config}`);
  });

providerCmd
  .command("remove")
  .description("Remove a provider")
  .argument("<id>", "Provider ID")
  .option("-c, --config <path>", "config file path", "/etc/cc-switch/config.yaml")
  .action((id, opts) => {
    const config = loadConfig(opts.config);
    const before = config.providers.length;
    config.providers = config.providers.filter((p) => p.id !== id);
    if (config.providers.length === before) {
      console.error(`Provider '${id}' not found`);
      process.exit(1);
    }
    if (config.current_provider === id) {
      config.current_provider = config.providers[0]?.id ?? "";
      console.log(`Current provider reset to '${config.current_provider}'`);
    }
    saveConfig(config, opts.config);
    console.log(`Provider '${id}' removed`);
  });

// 切换当前 provider + 自动写 ~/.claude/settings.json + 重启 systemd 服务
providerCmd
  .command("use")
  .description(
    "Switch the active provider. Updates /etc/cc-switch/config.yaml, rewrites ~/.claude/settings.json, and restarts the cc-switch systemd service."
  )
  .argument("<id>", "Provider ID to activate")
  .option(
    "-c, --config <path>",
    "cc-switch config file path",
    "/etc/cc-switch/config.yaml"
  )
  .option(
    "--claude-settings <path>",
    "Claude Code settings.json path",
    process.env["HOME"] + "/.claude/settings.json"
  )
  .option("--no-restart", "Don't restart systemd service (manual restart required)")
  .option("--no-write-claude", "Skip writing ~/.claude/settings.json")
  .action(async (id, opts) => {
    const config = loadConfig(opts.config);
    const provider = getProvider(config, id);
    if (!provider) {
      console.error(`Provider '${id}' not found. Run 'cc-switch provider list' to see available providers.`);
      process.exit(1);
    }

    // 1. 改 /etc/cc-switch/config.yaml
    config.current_provider = id;
    saveConfig(config, opts.config);
    console.log(`✓ Set '${id}' as current provider in ${opts.config}`);

    // 2. 改 ~/.claude/settings.json
    if (opts.writeClaude) {
      try {
        const proxyBaseUrl = `http://${config.listen_address}:${config.listen_port}`;
        const settings = buildClaudeSettings(provider, proxyBaseUrl);
        writeClaudeSettings(opts.claudeSettings, settings);
        console.log(`✓ Updated ${opts.claudeSettings} (BASE_URL=${proxyBaseUrl})`);
      } catch (e) {
        console.error(
          `✗ Failed to write ${opts.claudeSettings}: ${e instanceof Error ? e.message : e}`
        );
        console.error(`  Run 'cc-switch provider use ${id} --no-write-claude' to skip.`);
        process.exit(1);
      }
    }

    // 3. 重启 systemd 服务
    if (opts.restart) {
      const isSystemd = existsSync("/run/systemd/system");
      if (!isSystemd) {
        console.log(`⚠ systemd not detected. Restart the service manually:`);
        console.log(`    /usr/bin/cc-switch serve --config ${opts.config}`);
      } else {
        try {
          const proc = Bun.spawn(["systemctl", "restart", "cc-switch.service"], {
            stdout: "inherit",
            stderr: "inherit",
          });
          await proc.exited;
          if (proc.exitCode === 0) {
            console.log(`✓ Restarted cc-switch.service`);
          } else {
            console.error(`✗ systemctl restart failed (exit ${proc.exitCode})`);
            process.exit(1);
          }
        } catch (e) {
          console.error(
            `✗ Failed to invoke systemctl: ${e instanceof Error ? e.message : e}`
          );
          console.error(`  Run manually: sudo systemctl restart cc-switch`);
          process.exit(1);
        }
      }
    } else {
      console.log(`⚠ Skipped restart. Run: sudo systemctl restart cc-switch`);
    }

    console.log(`\nNow using: ${provider.name} (${provider.vendor})`);
    console.log(`Models: sonnet -> ${provider.models.sonnet ?? "(default)"}, opus -> ${provider.models.opus ?? "(default)"}, haiku -> ${provider.models.haiku ?? "(default)"}`);
  });

// 交互式添加 provider
providerCmd
  .command("add-interactive")
  .description("Interactively add a provider (prompts for fields)")
  .option("-c, --config <path>", "config file path", "/etc/cc-switch/config.yaml")
  .action(async (opts) => {
    const prompts = await import("node:util");
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

    const config = loadConfig(opts.config);
    if (getProvider(config, id)) {
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
    config.providers.push(provider);
    if (!config.current_provider) {
      config.current_provider = id;
    }
    saveConfig(config, opts.config);
    console.log(`\nProvider '${id}' added. ${config.current_provider === id ? "Set as current." : ""}`);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err }, "fatal error");
  process.exit(1);
});