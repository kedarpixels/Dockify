export interface ReadState {
  picked: boolean;
  branch: string;
  port: string;
  /** The operator changed a build field, so a finished read keeps their choices. */
  edited: boolean;
  detect: "idle" | "loading" | "done" | "error";
}

// Continue waits while a read is due or running, unless the operator typed the port. A port the
// last read filled in belongs to its branch, so going on would save that branch's Dockerfile.
export function waitsForRead(s: ReadState): boolean {
  if (!s.picked) return false;
  if (s.port.trim() && s.edited) return false;
  return s.detect === "loading" || (s.detect === "idle" && !!s.branch.trim());
}
