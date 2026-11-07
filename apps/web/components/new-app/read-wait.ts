/** What Continue needs to know about the read of the repository. */
export interface ReadState {
  picked: boolean;
  branch: string;
  port: string;
  /** The operator changed a build field, so a finished read keeps their choices. */
  edited: boolean;
  detect: "idle" | "loading" | "done" | "error";
}

/**
 * Continue waits while a read is due or running: it fills in the builder and the port, and step 3
 * cannot change them. Only a port the operator typed goes ahead without it. A port the last read
 * filled in does not: it belongs to the branch that read, and so does its builder, so going on
 * after a branch change would save the old branch's Dockerfile for a branch that has none.
 */
export function waitsForRead(s: ReadState): boolean {
  if (!s.picked) return false;
  if (s.port.trim() && s.edited) return false;
  return s.detect === "loading" || (s.detect === "idle" && !!s.branch.trim());
}
