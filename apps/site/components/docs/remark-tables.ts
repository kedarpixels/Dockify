/* Pipe tables without remark-gfm: MDX parses one as a plain paragraph, so a paragraph whose second line is a
   delimiter row becomes an mdast table node. Pipes inside inline code are separate nodes and never split a cell. */

type MdNode = { type: string; value?: string; children?: MdNode[]; [key: string]: unknown };
type Align = "left" | "right" | "center" | null;

const DELIM = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** The paragraph's inline nodes, cut into lines at soft breaks. */
function linesOf(children: MdNode[]): MdNode[][] {
  const lines: MdNode[][] = [[]];
  for (const c of children) {
    if (c.type !== "text" || !c.value?.includes("\n")) {
      lines[lines.length - 1]!.push(c);
      continue;
    }
    const parts = c.value.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1]!.push({ type: "text", value: p });
    });
  }
  return lines;
}

const plain = (line: MdNode[]) => line.map((n) => (n.type === "text" ? (n.value ?? "") : "\u0000")).join("");

/** One line's inline nodes, cut into cells at pipes in text nodes. */
function cellsOf(line: MdNode[]): MdNode[][] {
  const cells: MdNode[][] = [[]];
  for (const n of line) {
    if (n.type !== "text") {
      cells[cells.length - 1]!.push(n);
      continue;
    }
    const parts = (n.value ?? "").split("|");
    parts.forEach((p, i) => {
      if (i > 0) cells.push([]);
      if (p) cells[cells.length - 1]!.push({ type: "text", value: p });
    });
  }
  const blank = (c: MdNode[]) => c.every((n) => n.type === "text" && !n.value?.trim());
  if (cells.length && blank(cells[0]!)) cells.shift();
  if (cells.length && blank(cells[cells.length - 1]!)) cells.pop();
  return cells.map((c) => {
    const out = c.map((n) => ({ ...n }));
    const first = out[0];
    const last = out[out.length - 1];
    if (first?.type === "text") first.value = (first.value ?? "").replace(/^\s+/, "");
    if (last?.type === "text") last.value = (last.value ?? "").replace(/\s+$/, "");
    return out.filter((n) => n.type !== "text" || n.value);
  });
}

function toTable(p: MdNode): MdNode | null {
  const lines = linesOf(p.children ?? []);
  if (lines.length < 3 || !DELIM.test(plain(lines[1]!))) return null;
  if (!plain(lines[0]!).includes("|")) return null;
  const align: Align[] = plain(lines[1]!)
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((d) => {
      const s = d.trim();
      return s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : s.startsWith(":") ? "left" : null;
    });
  const width = align.length;
  const rows = [lines[0]!, ...lines.slice(2)].map((line) => {
    const cells = cellsOf(line);
    while (cells.length < width) cells.push([]);
    return { type: "tableRow", children: cells.slice(0, width).map((c) => ({ type: "tableCell", children: c })) };
  });
  return { type: "table", align, children: rows };
}

function walk(node: MdNode) {
  if (!node.children) return;
  node.children = node.children.map((c) => (c.type === "paragraph" ? (toTable(c) ?? c) : c));
  node.children.forEach(walk);
}

export function remarkPipeTables() {
  return (tree: MdNode) => walk(tree);
}
