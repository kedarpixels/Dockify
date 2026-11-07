/**
 * Observability settings, read once from the environment. Every value has a safe default, so the
 * worker runs with none of them set.
 */
export interface ObserveConfig {
  /** Sampler tick. Each tick writes one raw row for the host and one per running app container. */
  sampleMs: number;
  /** Alert evaluation tick. */
  alertMs: number;
  /** Control-plane probes for the "service" rule. Internal, operator-set addresses only. */
  probes: { api: string | null };
  /** The status page reachability probe (reach.ts), once per everyMs. */
  reach: { everyMs: number };
  /**
   * Runtime log lines are kept for the owner's Log retention setting (Instance.logRetentionDays,
   * logs.ts logRetentionDays); this value (DOCKIFY_RUNTIME_LOG_DAYS) counts only when the row has none.
   */
  logRetentionDays: number;
  /** Hard caps on runtime_log_lines on top of age: total size and rows per app (logs.ts enforceLogCaps). */
  logCaps: { maxTableBytes: number; maxRowsPerApp: number };
  /** Raw rows kept 24 h, five_min 30 d, hour 1 year (the MetricSample model comment). */
  retention: { rawHours: number; fiveMinDays: number; hourDays: number };
}

const num = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v.trim() !== "" ? Math.min(max, Math.max(min, n)) : fallback;
};

const str = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

export function loadObserveConfig(env: NodeJS.ProcessEnv = process.env): ObserveConfig {
  return {
    sampleMs: num(env.DOCKIFY_METRICS_SAMPLE_MS, 20_000, 5_000, 300_000),
    alertMs: num(env.DOCKIFY_ALERT_EVAL_MS, 30_000, 10_000, 300_000),
    probes: { api: str(env.DOCKIFY_PROBE_API_URL) },
    reach: { everyMs: num(env.DOCKIFY_REACH_PROBE_MS, 60_000, 15_000, 600_000) },
    logRetentionDays: num(env.DOCKIFY_RUNTIME_LOG_DAYS, 7, 1, 90),
    logCaps: {
      maxTableBytes: num(env.DOCKIFY_RUNTIME_LOG_MAX_MB, 4096, 256, 1024 * 1024) * 1024 ** 2,
      maxRowsPerApp: num(env.DOCKIFY_RUNTIME_LOG_MAX_ROWS_PER_APP, 500_000, 10_000, 50_000_000),
    },
    retention: { rawHours: 24, fiveMinDays: 30, hourDays: 365 },
  };
}
