// /stats 端点测试

import { describe, expect, test } from "bun:test";
import { Stats } from "../src/stats.ts";

describe("Stats 单实例", () => {
  test("初始 snapshot 是全零", () => {
    const stats = new Stats();
    const snap = stats.snapshot(null);
    expect(snap.totals.requests).toBe(0);
    expect(snap.totals.successful).toBe(0);
    expect(snap.totals.failed).toBe(0);
    expect(snap.totals.success_rate).toBe(0);
    expect(snap.by_provider).toEqual({});
    expect(snap.by_status_code).toEqual({});
    expect(snap.current_provider).toBeNull();
  });

  test("记录 1 个成功请求", () => {
    const stats = new Stats();
    stats.record("deepseek", 200);
    const snap = stats.snapshot("deepseek");
    expect(snap.totals.requests).toBe(1);
    expect(snap.totals.successful).toBe(1);
    expect(snap.totals.failed).toBe(0);
    expect(snap.totals.success_rate).toBe(100);
    expect(snap.by_provider.deepseek).toEqual({
      requests: 1,
      successful: 1,
      failed: 0,
    });
    expect(snap.by_status_code["200"]).toBe(1);
  });

  test("记录混合成功/失败", () => {
    const stats = new Stats();
    stats.record("deepseek", 200);
    stats.record("deepseek", 200);
    stats.record("deepseek", 502);
    stats.record("kimi", 200);
    stats.record("kimi", 503);
    const snap = stats.snapshot(null);
    expect(snap.totals.requests).toBe(5);
    expect(snap.totals.successful).toBe(3);
    expect(snap.totals.failed).toBe(2);
    expect(snap.totals.success_rate).toBe(60); // 3/5 = 60.00
    expect(snap.by_provider.deepseek).toEqual({
      requests: 3,
      successful: 2,
      failed: 1,
    });
    expect(snap.by_provider.kimi).toEqual({
      requests: 2,
      successful: 1,
      failed: 1,
    });
    expect(snap.by_status_code["200"]).toBe(3);
    expect(snap.by_status_code["502"]).toBe(1);
    expect(snap.by_status_code["503"]).toBe(1);
  });

  test("provider=null 表示无 provider 时的 503（不计入 by_provider）", () => {
    const stats = new Stats();
    stats.record(null, 503);
    stats.record("deepseek", 200);
    const snap = stats.snapshot(null);
    expect(snap.totals.requests).toBe(2);
    expect(snap.totals.failed).toBe(1);
    expect(snap.totals.successful).toBe(1);
    // by_provider 只记录有 provider 的请求
    expect(snap.by_provider.deepseek).toBeDefined();
    expect(Object.keys(snap.by_provider)).toHaveLength(1);
    // by_status_code 全部记录
    expect(snap.by_status_code["503"]).toBe(1);
    expect(snap.by_status_code["200"]).toBe(1);
  });

  test("2xx 是成功，4xx/5xx 是失败", () => {
    const stats = new Stats();
    for (const code of [200, 201, 204, 299]) {
      stats.record("p", code);
    }
    for (const code of [400, 404, 500, 502, 503]) {
      stats.record("p", code);
    }
    const snap = stats.snapshot(null);
    expect(snap.totals.successful).toBe(4);
    expect(snap.totals.failed).toBe(5);
  });

  test("success_rate 保留 2 位小数（向上取整边界）", () => {
    const stats = new Stats();
    // 1/3 = 33.333...%
    stats.record("p", 200);
    stats.record("p", 502);
    stats.record("p", 502);
    const snap = stats.snapshot(null);
    expect(snap.totals.success_rate).toBe(33.33);
  });

  test("uptime_seconds 递增（通过 fake timers 不实际测时间，测结构）", async () => {
    const stats = new Stats();
    const s1 = stats.snapshot(null);
    // 等 100ms
    await new Promise((r) => setTimeout(r, 100));
    const s2 = stats.snapshot(null);
    expect(s2.uptime_seconds).toBeGreaterThanOrEqual(s1.uptime_seconds);
    expect(s2.started_at).toBe(s1.started_at);
  });

  test("snapshot 不暴露内部 Map 引用（防止外部 mutate）", () => {
    const stats = new Stats();
    stats.record("p", 200);
    const snap = stats.snapshot(null);
    // mutate snapshot
    if (snap.by_provider.p) snap.by_provider.p.requests = 999;
    // 再次 snapshot 应该不受影响
    const snap2 = stats.snapshot(null);
    expect(snap2.by_provider.p?.requests).toBe(1);
  });

  test("reset() 清空所有计数（测试用）", () => {
    const stats = new Stats();
    stats.record("p", 200);
    stats.reset();
    const snap = stats.snapshot(null);
    expect(snap.totals.requests).toBe(0);
    expect(snap.by_provider).toEqual({});
  });
});

describe("Stats 边界", () => {
  test("100% 成功率", () => {
    const stats = new Stats();
    for (let i = 0; i < 100; i++) stats.record("p", 200);
    const snap = stats.snapshot(null);
    expect(snap.totals.success_rate).toBe(100);
  });

  test("0% 成功率（所有都失败）", () => {
    const stats = new Stats();
    stats.record("p", 502);
    stats.record("p", 503);
    const snap = stats.snapshot(null);
    expect(snap.totals.success_rate).toBe(0);
  });

  test("同 provider 多次记录聚合正确", () => {
    const stats = new Stats();
    for (let i = 0; i < 10; i++) stats.record("deepseek", 200);
    for (let i = 0; i < 3; i++) stats.record("deepseek", 502);
    const snap = stats.snapshot(null);
    expect(snap.by_provider.deepseek?.requests).toBe(13);
    expect(snap.by_provider.deepseek?.successful).toBe(10);
    expect(snap.by_provider.deepseek?.failed).toBe(3);
  });
});
