// Toast titles are short sentence case with no full stop. Descriptions name the object.

import { toast, type ToastOptions } from "@/components/ui/toast";
import { isStepUpCancel } from "./step-up";

/** Appended to every toast description while the page runs on the preview fixture. */
export const PREVIEW_NOTE = "Preview, nothing was sent";

type Part = string | null | undefined | false;

/** Joins the parts with ". " and adds the preview note. Trailing full stops are dropped so joins never double them. */
export function describe(parts: Part | Part[], { preview = false }: { preview?: boolean } = {}): string | undefined {
  const list = (Array.isArray(parts) ? parts : [parts])
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim().replace(/\.+$/, ""))
    .filter(Boolean);
  if (preview) list.push(PREVIEW_NOTE);
  return list.length ? list.join(". ") : undefined;
}

/** An Error's message, a thrown string, or an API body's `error` or `message`. */
export function errText(e: unknown, fallback = "Something went wrong"): string {
  const text =
    e instanceof Error ? e.message
    : typeof e === "string" ? e
    : e && typeof e === "object" && "error" in e && typeof e.error === "string" ? e.error
    : e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message
    : "";
  return text.trim() || fallback;
}

/** Any write result the pages pass around: settings' Outcome, project-detail's MutationResult. */
export type Result = { ok: true; source?: string } | { ok: false; error?: string | null; source?: string };

/** Toasts a finished write and hands the result back. A write the operator stopped by closing
 * "Confirm it is you" reports nothing, and the loading toast it replaced (`id`) goes away. */
export function report<R extends Result>(
  result: R,
  m: { success: string; error: string; what?: string; preview?: boolean; action?: ToastOptions["action"]; id?: string },
): R {
  if (isStepUpCancel(result)) {
    if (m.id) toast.dismiss(m.id);
    return result;
  }
  if (result.ok) {
    const preview = m.preview ?? result.source === "preview";
    toast.success(m.success, { id: m.id, description: describe(m.what, { preview }), action: m.action });
  } else {
    toast.error(m.error, { id: m.id, description: errText(result.error) });
  }
  return result;
}
