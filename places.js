// Pure tree helpers for the place navigator. No DOM, no fetch -- so they are
// unit-testable under plain node.

// Rows are FLAT and ordered depth-first; the root is excluded because it gets
// its own dedicated "all of <city>" row in the panel.
export function flattenTree(root) {
  const rows = [];
  const walk = (node, depth, parentId) => {
    for (const child of node.children || []) {
      rows.push({ id: child.id, name: child.name, depth, node: child, parentId });
      walk(child, depth + 1, child.id);
    }
  };
  if (root) walk(root, 0, null);
  return rows;
}

// Fold diacritics so "etelainen" finds "Eteläinen" and "botzow" finds "Bötzow".
// NFD decomposition handles most diacritics, but some letters (ß, ø, ł, etc.) do not
// decompose under NFD and require explicit mapping. Weißensee in Berlin data was
// unfindable as "weissensee" without this.
function norm(s) {
  s = s.toLowerCase();
  // NFD handles decomposable diacritics (é, ñ, ü, etc.).
  s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  // Non-decomposing letters require explicit folding.
  const nonDecomposing = {
    "ß": "ss", "ø": "o", "ł": "l", "ð": "d", "þ": "th",
    "æ": "ae", "å": "a", "œ": "oe", "đ": "d", "ı": "i"
  };
  for (const [char, replacement] of Object.entries(nonDecomposing)) {
    s = s.replaceAll(char, replacement);
  }
  return s;
}

// A matching CHILD keeps its ancestors visible, otherwise a hit appears with no
// context. Ancestors are kept in their original order.
export function filterRows(rows, query) {
  const q = norm((query || "").trim());
  if (!q) return rows;
  const keep = new Set();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    if (!norm(row.name).includes(q)) continue;
    keep.add(row.id);
    let pid = row.parentId;
    while (pid && byId.has(pid) && !keep.has(pid)) {
      keep.add(pid);
      pid = byId.get(pid).parentId;
    }
  }
  return rows.filter((r) => keep.has(r.id));
}

export function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}
