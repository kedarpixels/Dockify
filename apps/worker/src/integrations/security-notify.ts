/**
 * The security_notify job: one email per admin the first time the updater sees a security release.
 * The payload is checked as strictly as the feed was: a job row cannot make an alert up. Each message's
 * idempotency key names the release and the admin, so a retry or a requeue never sends twice.
 */
import type { Db, SecretVault } from "@dockify/db";
import { updateNotice, type Mailer } from "@dockify/email";
import { PermanentJobError } from "../errors.ts";
import { loadSender, mailEach } from "./email.ts";

export interface SecurityNotify {
  version: string;
  level: "critical" | "important";
  summary: string;
  advisory: string | null;
  cves: string[];
  current: string | null;
}

const VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const CVE = /^CVE-\d{4}-\d{4,7}$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function parseSecurityNotify(raw: unknown): SecurityNotify {
  const p = raw as Partial<Record<keyof SecurityNotify, unknown>> | null;
  const bad = () => new PermanentJobError("security_notify payload is malformed");
  if (!p || typeof p !== "object") throw bad();
  if (typeof p.version !== "string" || !VERSION.test(p.version)) throw bad();
  if (p.level !== "critical" && p.level !== "important") throw bad();
  if (typeof p.summary !== "string" || !p.summary.trim() || p.summary.length > 600 || CONTROL.test(p.summary)) throw bad();
  let advisory: string | null = null;
  if (p.advisory !== null && p.advisory !== undefined) {
    if (typeof p.advisory !== "string" || p.advisory.length > 500) throw bad();
    try {
      const u = new URL(p.advisory);
      if (u.protocol !== "https:" || u.username || u.password) throw bad();
    } catch {
      throw bad();
    }
    advisory = p.advisory;
  }
  const cves = p.cves ?? [];
  if (!Array.isArray(cves) || cves.length > 20 || !cves.every((c) => typeof c === "string" && CVE.test(c))) throw bad();
  if (p.current !== null && p.current !== undefined && (typeof p.current !== "string" || !VERSION.test(p.current))) throw bad();
  return {
    version: p.version.replace(/^v/, ""),
    level: p.level,
    summary: p.summary.trim(),
    advisory,
    cves: cves as string[],
    current: typeof p.current === "string" ? p.current.replace(/^v/, "") : null,
  };
}

export interface SecurityNotifyDeps {
  db: Db;
  vault: SecretVault;
  mail: Mailer;
  publicUrl: string | null;
}

/** Throws to retry, PermanentJobError to stop. */
export async function deliverSecurityNotice(deps: SecurityNotifyDeps, raw: unknown): Promise<number> {
  const n = parseSecurityNotify(raw);
  let url: URL | null = null;
  try {
    url = deps.publicUrl ? new URL("/server#updates", deps.publicUrl) : null;
  } catch {
    url = null;
  }
  if (!url) return 0;
  const sender = await loadSender(deps.db, deps.vault);
  if (!sender) return 0;
  const [inst, admins] = await Promise.all([
    deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } }),
    deps.db.member.findMany({ where: { role: "admin", user: { disabledAt: null } }, select: { user: { select: { id: true, email: true } } } }),
  ]);
  const message = updateNotice({
    instanceName: inst?.name ?? "Dockify",
    origin: url.origin,
    event: "security",
    version: n.version,
    from: n.current,
    error: null,
    url: url.toString(),
    security: { level: n.level, summary: n.summary, advisory: n.advisory, cves: n.cves },
  });
  return mailEach(deps, sender, admins.map((a) => a.user), message, (id) => `security-release:${n.version}:${id}`);
}
