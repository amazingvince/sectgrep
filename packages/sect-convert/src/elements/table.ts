import type { TableCell } from "../document.generated.js";

/** Native HTML/JATS table geometry and explicit header semantics. A first row of <td>
 * remains data. No domain meaning is assigned from position or numerical values.
 */
export function nativeTable(
  table: globalThis.Element,
  prefix: string,
): { grid: string[][]; cells: TableCell[]; flags: string[] } {
  const cells: TableCell[] = [];
  const native = new Map<string, string>();
  const nodes: globalThis.Element[] = [];
  const occupied = new Set<string>();
  const nearestTable = (node: globalThis.Element) => {
    for (let p = node.parentNode; p?.nodeType === 1; p = p.parentNode)
      if ((p as globalThis.Element).tagName.toLowerCase() === "table") return p;
    return null;
  };
  const rows = Array.from(table.getElementsByTagName("tr")).filter(
    (row) => nearestTable(row) === table,
  );
  const positive = (value: string | null) => {
    const n = Number(value ?? 1);
    return Number.isInteger(n) && n > 0 && n <= 10000 ? n : 1;
  };
  rows.forEach((tr, row) => {
    let column = 0;
    for (const node of Array.from(tr.childNodes).filter(
      (n): n is globalThis.Element =>
        n.nodeType === 1 &&
        ["td", "th"].includes((n as globalThis.Element).tagName.toLowerCase()),
    )) {
      while (occupied.has(`${row}:${column}`)) column++;
      const row_span = positive(node.getAttribute("rowspan")),
        column_span = positive(node.getAttribute("colspan"));
      const cell: TableCell = {
        id: `${prefix}-cell-${cells.length}`,
        row,
        column,
        row_span,
        column_span,
        text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
        role: node.tagName.toLowerCase() === "th" ? "header" : "data",
        headers: [],
      };
      if (
        column + column_span > 4096 ||
        rows.length * (column + column_span) > 2_000_000
      )
        throw new Error("native table exceeds bounded grid capacity");
      for (let r = row; r < Math.min(rows.length, row + row_span); r++)
        for (let c = column; c < column + column_span; c++)
          occupied.add(`${r}:${c}`);
      const id = node.getAttribute("id");
      if (id) native.set(id, cell.id);
      cells.push(cell);
      nodes.push(node);
      column += column_span;
    }
  });
  const inHead = (node: globalThis.Element) => {
    for (
      let p = node.parentNode;
      p?.nodeType === 1 && p !== table;
      p = p.parentNode
    )
      if ((p as globalThis.Element).tagName.toLowerCase() === "thead")
        return true;
    return false;
  };
  cells.forEach((cell, i) => {
    const declared = (nodes[i].getAttribute("headers") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (declared.length)
      cell.headers = declared.map((id) => {
        const found = native.get(id);
        if (!found) throw new Error(`table names a missing header cell: ${id}`);
        return found;
      });
    else if (cell.role === "data")
      cell.headers = cells
        .filter((header, j) => {
          if (header.role !== "header") return false;
          const scope = nodes[j].getAttribute("scope")?.toLowerCase();
          if (scope === "row")
            return (
              header.row <= cell.row &&
              header.row + header.row_span > cell.row &&
              header.column < cell.column
            );
          if (scope === "col" || (!scope && inHead(nodes[j])))
            return (
              header.row < cell.row &&
              header.column < cell.column + cell.column_span &&
              header.column + header.column_span > cell.column
            );
          return false;
        })
        .map((h) => h.id);
  });
  const width = cells.reduce(
    (n, c) => Math.max(n, c.column + c.column_span),
    0,
  );
  const grid = rows.map(() => Array<string>(width).fill(""));
  for (const cell of cells) grid[cell.row][cell.column] = cell.text;
  return {
    grid,
    cells,
    flags: cells.some((c) => c.role === "data" && !c.headers.length)
      ? ["table_header_associations_unknown"]
      : [],
  };
}
