// Pure tree helpers for the place navigator. No DOM, no fetch -- so they are
// unit-testable under plain node.

// Rows are FLAT and ordered depth-first; the root is excluded because it gets
// its own dedicated "all of <city>" row in the panel.
export function flattenTree(root) {
  const rows = [];
  const walk = (node, depth, parentId) => {
    for (const child of node.children || []) {
      // `density`/`famous` are baked onto depth-1 nodes by schema 2 and must be
      // COPIED onto the flat row: rankRows reads `row.density`, not
      // `row.node.density`, so without this every row looks unranked and the
      // density order silently degrades to plain tree order. Schema-1 trees
      // simply leave both undefined, which rankRows already tolerates.
      rows.push({
        id: child.id, name: child.name, depth, node: child, parentId,
        density: child.density, famous: child.famous,
      });
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

// Density is BAKED into places.json (worldripples/placescore.py). It is never
// derived here -- that needs the binaries, and the panel must stay cheap.
//
// Ranking happens WITHIN each sibling group, never across depth levels. A flat
// global sort looks right on a depth-1-only city, but density is baked only on
// depth-1 nodes, so on berlin/amsterdam/helsinki every depth-2 sub-district
// fell into the unranked bucket and was appended after ALL parents. panel.js
// indents by depth, so those children rendered under a stranger. Grouping by
// parentId and re-emitting parent-then-its-children keeps the list a tree.
export function rankRows(rows) {
  // Siblings, in their original (tree) order, keyed by parent.
  const groups = new Map();
  for (const row of rows) {
    const key = row.parentId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Densest first among siblings; rows without a density keep their original
  // relative order and stay after the scored ones. `typeof === "number"` is
  // deliberate: density 0 is a real score and must rank, not fall through.
  const orderSiblings = (siblings) => {
    const ranked = siblings.filter((r) => typeof r.density === "number");
    const rest = siblings.filter((r) => typeof r.density !== "number");
    // Array.prototype.sort is stable, so ties keep their original order.
    ranked.sort((a, b) => b.density - a.density);
    return [...ranked, ...rest];
  };

  const out = [];
  const emit = (parentKey) => {
    for (const row of orderSiblings(groups.get(parentKey) || [])) {
      out.push(row);
      // Guard against a cycle / self-parent in malformed data.
      if (row.id !== parentKey && groups.has(row.id)) emit(row.id);
    }
  };

  // Top-level rows are the ones whose parent is not itself a row (flattenTree
  // gives depth-0 rows parentId null; a FILTERED list can orphan deeper rows,
  // and those must still be emitted rather than silently dropped).
  const present = new Set(rows.map((r) => r.id));
  const roots = [];
  for (const key of groups.keys()) {
    if (key === null || !present.has(key)) roots.push(key);
  }
  for (const key of roots) emit(key);
  return out;
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
