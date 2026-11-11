"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Select, type SelectOption } from "@/components/ui/select";
import { parseZonedInput, zonedInputValue } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { useTimeFormat, type TimeFormat } from "@/lib/time-prefs";
import { RANGE_LABEL, RETENTION_MS, type LogFilters, type LogRange } from "./model";

/* The custom fields take the user's zone; the filters keep ISO strings. */

/** "30 Oct 2026, 14:05 to 14:35", with the end's date only when it is another day. */
function span(from: string, to: string, fmt: TimeFormat) {
  const a = fmt.abs(from);
  const b = fmt.abs(to);
  const [day, time] = b.split(", ");
  return `${a} to ${a.startsWith(`${day},`) ? time : b}`;
}

type Window = Pick<LogFilters, "range" | "from" | "to">;

export function RangePicker({ value, onChange }: { value: Window; onChange: (next: Window) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The earliest and latest moments the fields offer, fixed when the dialog opens.
  const [bounds, setBounds] = useState({ min: "", max: "" });

  // Local times differ between the server and the browser, so the window shows after mount.
  const hydrated = useHydrated();
  const time = useTimeFormat();
  const local = (ms: number) => zonedInputValue(ms, time.prefs);
  const custom = hydrated && value.range === "custom" && value.from && value.to ? span(value.from, value.to, time) : RANGE_LABEL.custom;
  const options: SelectOption<LogRange>[] = (["15m", "1h", "24h", "7d"] as const).map((r) => ({ value: r, label: RANGE_LABEL[r], icon: "clock" }));
  options.push({ value: "custom", label: custom, icon: "calendar" });

  const openCustom = () => {
    const now = Date.now();
    setFrom(local(value.from ? Date.parse(value.from) : now - 3_600_000));
    setTo(local(value.to ? Date.parse(value.to) : now));
    setBounds({ min: local(now - RETENTION_MS), max: local(now + 60_000) });
    setError(null);
    setOpen(true);
  };

  const apply = () => {
    const a = parseZonedInput(from, time.prefs);
    const b = parseZonedInput(to, time.prefs);
    if (Number.isNaN(a) || Number.isNaN(b)) return setError("Pick both a start and an end");
    if (a >= b) return setError("The end must be after the start");
    if (a < Date.now() - RETENTION_MS) return setError("Logs are kept for 7 days. Pick a later start");
    onChange({ range: "custom", from: new Date(a).toISOString(), to: new Date(b).toISOString() });
    setOpen(false);
  };

  const { min, max } = bounds;

  return (
    <>
      <Select
        className="lx-range"
        label="Time range"
        value={value.range}
        options={options}
        align="end"
        onChange={(r) => (r === "custom" ? openCustom() : onChange({ range: r }))}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Custom range"
        sub="A fixed window in your local time. Logs are kept for 7 days."
        icon="calendar"
        size="sm"
        onSubmit={apply}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              <Icon name="check" />
              Apply range
            </button>
          </>
        }
      >
        <div className="lx-range-fields">
          <Field label="From" error={error}>
            {(ids) => <DateTimePicker ids={ids} label="From" value={from} min={min} max={max} hour12={time.prefs.hour12} onChange={setFrom} autoFocus />}
          </Field>
          <Field label="To">{(ids) => <DateTimePicker ids={ids} label="To" value={to} min={min} max={max} hour12={time.prefs.hour12} onChange={setTo} />}</Field>
        </div>
      </Dialog>
    </>
  );
}
