/* Text out of the page: a multi-row selection read as plain lines, and a text file download. */

/**
 * The selected text, one line per row and without any gutter, or null when the selection stays
 * inside one row (the browser copies that itself). `row` and `text` select a row and its text cell.
 */
export function selectedText(range: Range, box: HTMLElement, row: string, text: string): string | null {
  const rows = Array.from(box.querySelectorAll<HTMLElement>(row)).filter((r) => range.intersectsNode(r));
  if (rows.length < 2) return null;
  const out: string[] = [];
  for (const r of rows) {
    const tx = r.querySelector(text);
    if (!tx) continue;
    // Skip a row whose text starts after the selection ends or ends before it starts.
    if (range.comparePoint(tx, 0) === 1 || range.comparePoint(tx, tx.childNodes.length) === -1) continue;
    const part = document.createRange();
    part.selectNodeContents(tx);
    if (range.comparePoint(part.startContainer, part.startOffset) === -1) part.setStart(range.startContainer, range.startOffset);
    if (range.comparePoint(part.endContainer, part.endOffset) === 1) part.setEnd(range.endContainer, range.endOffset);
    out.push(part.toString());
  }
  return out.join("\n");
}

/** Saves text as a file through a short-lived object URL. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
