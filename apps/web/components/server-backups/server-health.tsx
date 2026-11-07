import { CardTitle } from "@/components/card-title";
import { Icon, type IconName } from "@/components/icon";
import { StatusChip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { Empty } from "@/components/ui/empty";
import { IconTile } from "@/components/ui/icon-tile";
import { When } from "@/components/ui/when";
import type { ServerSnapshot, ServiceHealth } from "@/lib/pages/server-backups";
import { v } from "./util";

/* The control plane's own services and the facts of the host, side by side on /server. */

const SERVICE_NAME: Record<ServiceHealth["id"], string> = {
  api: "API",
  worker: "Worker",
  proxy: "Proxy",
  postgres: "Postgres",
  redis: "Redis",
  // Short enough for the 80px name column: the socket proxy is the control plane's way to Docker,
  // cloudflared is the Cloudflare Tunnel.
  web: "Dashboard",
  buildkit: "BuildKit",
  socketProxy: "Docker",
  updater: "Updater",
  cloudflared: "Tunnel",
};

const SERVICE_ICON: Record<ServiceHealth["id"], IconName> = {
  api: "server",
  worker: "layers",
  proxy: "globe",
  postgres: "database",
  redis: "bolt",
  web: "window",
  buildkit: "box",
  socketProxy: "lock",
  updater: "download",
  cloudflared: "cloud",
};

const SERVICE_TONE = { ok: "ok", degraded: "warn", down: "bad" } as const;
const SERVICE_LABEL = { ok: "Healthy", degraded: "Degraded", down: "Down" } as const;

/**
 * The probe's own words, unless they only restate the latency the next column already shows
 * ("answered in 32 ms"); then the row says what was checked. Postgres is probed with a query.
 */
function checked(s: ServiceHealth): string {
  // Padded with spaces, so a 2 ms latency never matches the "32 ms" inside a detail.
  const restates = s.latencyMs !== null && ` ${s.detail} `.includes(` ${s.latencyMs} ms `);
  if (!restates) return s.detail;
  if (s.id === "postgres") return "answered a test query";
  return s.detail.replace(` in ${s.latencyMs} ms`, "").trim() || s.detail;
}

export function ServicesCard({ services, checkedAt, now }: { services: ServiceHealth[]; checkedAt: string; now: number }) {
  const bad = services.filter((s) => s.status !== "ok").length;
  const sub = (
    <>
      {bad ? `${bad} of ${services.length} need${bad === 1 ? "s" : ""} attention` : "All healthy"}, <When iso={checkedAt} now={now} prefix="checked" />
    </>
  );
  return (
    <section className="card sb-svc" aria-labelledby="sb-svc-title">
      <div className="card-hd">
        <CardTitle id="sb-svc-title" icon="activity" title="Services" sub={sub} />
      </div>
      {services.length === 0 ? (
        <Empty icon="server" title="No health checks yet" body="Dockify’s own services report here once the API sends their checks." />
      ) : (
        <ul className="soft-list sb-svc-list">
          {services.map((s) => (
            <li key={s.id} className="soft-row sb-svc-row" data-status={s.status}>
              <IconTile>
                <Icon name={SERVICE_ICON[s.id]} />
              </IconTile>
              <span className="sb-svc-id">
                <span className="sb-svc-name">{SERVICE_NAME[s.id]}</span>
                <span className="sb-svc-detail">{checked(s)}</span>
              </span>
              <span className="sb-svc-end">
                {/* Only a probe has a round trip; a heartbeat or a container state has none to show. */}
                <span className={`sb-svc-lat num${s.latencyMs === null && s.status === "down" ? " tone-bad" : ""}`}>
                  {s.latencyMs !== null ? `${s.latencyMs} ms` : s.status === "down" ? "No answer" : ""}
                </span>
                <StatusChip tone={SERVICE_TONE[s.status]}>{SERVICE_LABEL[s.status]}</StatusChip>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// -------------- System --------------

export function SystemCard({ s }: { s: ServerSnapshot }) {
  const facts: Array<{ label: string; value: string; copy?: boolean }> = [
    { label: "Host", value: [s.host.name, s.host.region].filter(Boolean).join(", ") },
    { label: "IP address", value: s.system.ip, copy: true },
    { label: "OS", value: s.system.os },
    { label: "Kernel", value: s.system.kernel },
    { label: "Docker", value: s.system.docker },
    { label: "Dockify", value: v(s.system.dockify) },
  ];
  return (
    <section className="card sb-sys" aria-labelledby="sb-sys-title">
      <div className="card-hd">
        <CardTitle id="sb-sys-title" icon="info" title="System" sub="What this server runs" />
      </div>
      <dl className="sb-facts">
        {facts.map((f) => (
          <div key={f.label} className="sb-fact">
            <dt>{f.label}</dt>
            <dd className="num">
              <span className="sb-fact-val">{f.value}</span>
              {f.copy ? <CopyButton value={f.value} what={f.label} align="end" /> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
