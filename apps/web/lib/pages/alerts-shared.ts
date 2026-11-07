import type { AppKind, OverviewSource } from "@/lib/types";
import type { WebhookRef } from "@/lib/webhooks";

/*
 * The client-safe half of the Alerts page: types, the metric, channel and threshold lists, and the
 * pure checks the rule and mute dialogs use. The loader (lib/pages/alerts.ts) re-exports all of it;
 * client components import from here, so no server code or preview fixture reaches the browser.
 */

// -------------- Types --------------

export type AlertMetric = "disk" | "service" | "down" | "crashLoop" | "memory";
/** Where a rule sends besides its webhooks (AlertRule.webhooks): email to the admins, the in-app bell. */
export type AlertChannel = "email" | "bell";
export type ControlService = "any" | "api" | "worker" | "proxy" | "database";
export type MuteHours = 1 | 8 | 24;

/** Server rules watch this box and the control plane; app rules watch one app. */
export const SERVER_METRICS: AlertMetric[] = ["disk", "service"];
export const APP_METRICS: AlertMetric[] = ["down", "crashLoop", "memory"];
export const CHANNELS: AlertChannel[] = ["email", "bell"];
/** A rule sends to at most this many webhooks (the API's limit). */
export const MAX_RULE_WEBHOOKS = 50;
export const SERVICES: ControlService[] = ["any", "api", "worker", "proxy", "database"];
export const DURATIONS = [1, 2, 5, 10, 15, 30, 60] as const;
export const MUTE_HOURS: MuteHours[] = [1, 8, 24];

/** Allowed thresholds per metric; metrics without an entry take none. */
export const THRESHOLD: Partial<Record<AlertMetric, { min: number; max: number; fallback: number }>> = {
  disk: { min: 50, max: 99, fallback: 85 },
  memory: { min: 50, max: 100, fallback: 90 },
  crashLoop: { min: 2, max: 50, fallback: 3 },
};

/** The app a rule or event is about, sent whole so a deleted app still reads in the history. */
export interface AlertApp {
  id: string;
  name: string;
  kind: AppKind;
  projectSlug: string;
  environment: string;
}

export interface AlertRule {
  id: string;
  metric: AlertMetric;
  /** Null for server rules. */
  app: AlertApp | null;
  /** Only for `service`. */
  service: ControlService | null;
  /** Percent for disk and memory; restarts for crashLoop; null for down and service. */
  threshold: number | null;
  durationMin: number;
  channels: AlertChannel[];
  /** The webhooks it sends to, by id; AlertsPayload.webhooks names them. */
  webhooks: string[];
  enabled: boolean;
  /** True while one of its events is firing. */
  firing: boolean;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  metric: AlertMetric;
  app: AlertApp | null;
  service: ControlService | null;
  status: "firing" | "resolved";
  startedAt: string;
  resolvedAt: string | null;
  /** What the worker saw, in words: "91% of 2 GB", "Restarted 6 times in 10 minutes". */
  detail: string;
  /** Where the deep link points: the app, or /server for server rules. */
  href: string;
  /** True when the app was muted, so no channel was told. */
  muted: boolean;
}

export interface AlertMute {
  appId: string;
  until: string;
  createdAt: string;
}

export interface AlertsPayload {
  rules: AlertRule[];
  events: AlertEvent[];
  mutes: AlertMute[];
  /** Whether email is set up; the bell is always there. */
  channels: { email: boolean };
  /** Every webhook a rule can send to, in the order they were added (Settings, Integrations). */
  webhooks: WebhookRef[];
}

export interface AlertsResult {
  source: OverviewSource;
  data: AlertsPayload | null;
  error?: string;
  fetchedAt: string;
}

export interface RuleInput {
  metric: AlertMetric;
  appId: string | null;
  service: ControlService | null;
  threshold: number | null;
  durationMin: number;
  channels: AlertChannel[];
  webhooks: string[];
  enabled: boolean;
}

export const isOneOf = <T extends string | number>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

export const isMuteHours = (v: unknown): v is MuteHours => isOneOf(MUTE_HOURS, v);
