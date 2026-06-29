// 运行时统计（轻量 in-memory metrics）
//
// 设计：
// - 单实例（在 server 内 new 一次）
// - Bun 是单线程事件循环，无需 mutex
// - 数据只保留在内存，进程重启清零（用户接受）
// - 输出 JSON 格式（v0.5.0+ 可扩展 Prometheus 格式）

export interface ProviderStats {
  requests: number;
  successful: number;
  failed: number;
}

export interface StatsSnapshot {
  /** 进程启动到现在的秒数 */
  uptime_seconds: number;
  /** 进程启动时间（ISO 8601） */
  started_at: string;
  /** 当前激活的 provider id（来自 /health，不参与 stats 路由计算） */
  current_provider: string | null;
  totals: {
    requests: number;
    successful: number;
    failed: number;
    /** 百分比 0-100，保留 2 位小数；requests=0 时为 0 */
    success_rate: number;
  };
  by_provider: Record<string, ProviderStats>;
  by_status_code: Record<string, number>;
}

export class Stats {
  private readonly startedAt: Date = new Date();
  private totalRequests: number = 0;
  private totalSuccessful: number = 0;
  private totalFailed: number = 0;
  private readonly byProvider: Map<string, ProviderStats> = new Map();
  private readonly byStatusCode: Map<number, number> = new Map();

  /**
   * 记录一次请求结果
   * @param providerId 当前请求命中的 provider id（null = 无 provider）
   * @param statusCode HTTP 状态码（200/400/500/...）
   */
  record(providerId: string | null, statusCode: number): void {
    this.totalRequests++;

    // 状态码分类：2xx = 成功，4xx/5xx = 失败
    const successful = statusCode >= 200 && statusCode < 300;
    if (successful) {
      this.totalSuccessful++;
    } else {
      this.totalFailed++;
    }

    // 按 provider 累计
    if (providerId !== null) {
      let entry = this.byProvider.get(providerId);
      if (!entry) {
        entry = { requests: 0, successful: 0, failed: 0 };
        this.byProvider.set(providerId, entry);
      }
      entry.requests++;
      if (successful) entry.successful++;
      else entry.failed++;
    }

    // 按状态码累计
    this.byStatusCode.set(
      statusCode,
      (this.byStatusCode.get(statusCode) ?? 0) + 1
    );
  }

  /**
   * 输出 stats snapshot
   * @param currentProvider 当前激活的 provider（来自 DB，不在 stats 内部）
   */
  snapshot(currentProvider: string | null): StatsSnapshot {
    const successRate =
      this.totalRequests === 0
        ? 0
        : Math.round((this.totalSuccessful / this.totalRequests) * 10000) / 100;

    const byProviderObj: Record<string, ProviderStats> = {};
    for (const [k, v] of this.byProvider) {
      byProviderObj[k] = { ...v };
    }

    const byStatusCodeObj: Record<string, number> = {};
    for (const [k, v] of this.byStatusCode) {
      byStatusCodeObj[String(k)] = v;
    }

    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      started_at: this.startedAt.toISOString(),
      current_provider: currentProvider,
      totals: {
        requests: this.totalRequests,
        successful: this.totalSuccessful,
        failed: this.totalFailed,
        success_rate: successRate,
      },
      by_provider: byProviderObj,
      by_status_code: byStatusCodeObj,
    };
  }

  /** 重置所有计数（用于测试） */
  reset(): void {
    this.totalRequests = 0;
    this.totalSuccessful = 0;
    this.totalFailed = 0;
    this.byProvider.clear();
    this.byStatusCode.clear();
  }
}