import { Chip } from "./chip";

/** Days, hours and minutes, never seconds. */
export function UptimeChip({ seconds }: { seconds: number }) {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts: Array<[string, string]> = [[pad(h), "h"], [pad(m), "m"]];
  if (d) parts.unshift([String(d), "d"]);
  const spoken = d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
  return (
    <Chip size="sm" icon={<span className="uptime-dot" />} tip={`Up ${spoken}`} tipAlign="end" className="uptime-chip">
      <span className="sr">Up {spoken}</span>
      <span className="num up-clock" aria-hidden="true">
        {parts.map(([n, u]) => (
          <span key={u} className="up-part">
            {n}
            <span className="up-unit">{u}</span>
          </span>
        ))}
      </span>
    </Chip>
  );
}
