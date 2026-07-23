// panel.js -- the place navigator: city switcher + searchable place tree.
// ONLY navigates. Clicking fires onSelect(node) (app.js flies the camera and
// highlights); hovering fires onHover(node|null). No ripple filtering --
// district admission stays retired (v2.2 spec Q4-A).

// There is deliberately NO hardcoded city or district list here. The old
// CITY_ORDER = ["Helsinki","Espoo","Vantaa","Kauniainen"] made this panel
// render nothing for Berlin even when Berlin had data.

import { filterRows, flattenTree } from "./places.js?v=2e8fe65b76";

// Below this many rows a search box is noise rather than help.
const SEARCH_MIN_ROWS = 15;

export function createPlacePanel(rootEl, { tree, cities, activeSlug, onSelect,
                                           onCity, onHover, signal }) {
  const rows = flattenTree(tree);

  rootEl.hidden = false;
  // classList survives the innerHTML swap: a panel left open in city A would
  // otherwise return in city B as expanded chrome around a hidden body.
  rootEl.classList.remove("open");
  rootEl.innerHTML =
    '<button id="dp-tab" type="button" aria-expanded="false" aria-controls="dp-body">Places</button>' +
    '<div id="dp-body" hidden>' +
    '  <div id="dp-cities" role="group" aria-label="City"></div>' +
    '  <input id="dp-search" type="search" placeholder="Search places" ' +
    '         aria-label="Search places" hidden>' +
    '  <div id="dp-list" role="listbox"></div>' +
    "</div>";

  const tabEl = rootEl.querySelector("#dp-tab");
  const bodyEl = rootEl.querySelector("#dp-body");
  const citiesEl = rootEl.querySelector("#dp-cities");
  const searchEl = rootEl.querySelector("#dp-search");
  const listEl = rootEl.querySelector("#dp-list");

  tabEl.addEventListener("click", () => {
    const open = bodyEl.hidden;
    bodyEl.hidden = !open;
    tabEl.setAttribute("aria-expanded", String(open));
    rootEl.classList.toggle("open", open);
    if (open) searchEl.focus();
  }, { signal });

  for (const city of cities || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dp-cityswitch";
    b.textContent = city.display_name;
    b.classList.toggle("active", city.slug === activeSlug);
    b.addEventListener("click", () => onCity(city.slug), { signal });
    citiesEl.appendChild(b);
  }

  searchEl.hidden = rows.length < SEARCH_MIN_ROWS;
  searchEl.addEventListener("input", () => render(), { signal });

  let activeId = tree ? tree.id : null;
  const rowEls = new Map(); // id -> element. Id-keyed, never name-keyed:
  // Blankenfelde exists at two levels in Berlin and Helsinki has 7 dupes.

  function makeRow(id, name, depth, node) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = depth === 0 ? "dp-parent" : "dp-child";
    b.style.paddingLeft = `${10 + depth * 14}px`;
    b.textContent = name;
    b.classList.toggle("active", id === activeId);
    b.addEventListener("click", () => { activeId = id; onSelect(node); render(); },
                       { signal });
    b.addEventListener("mouseenter", () => onHover(node), { signal });
    rowEls.set(id, b);
    return b;
  }

  function render() {
    listEl.textContent = "";
    rowEls.clear();

    // The root row: "All of Berlin". This is what the redundant Region chip
    // used to do, in the place it belongs.
    if (tree) {
      listEl.appendChild(makeRow(tree.id, `All of ${tree.name}`, 0, tree));
    }

    const visible = filterRows(rows, searchEl.hidden ? "" : searchEl.value);
    for (const row of visible) {
      listEl.appendChild(makeRow(row.id, row.name, row.depth + 1, row.node));
    }
    if (visible.length === 0 && !searchEl.hidden && searchEl.value.trim()) {
      const empty = document.createElement("div");
      empty.className = "dp-empty";
      empty.textContent = "No places match.";
      listEl.appendChild(empty);
    }
  }

  listEl.addEventListener("mouseleave", () => onHover(null), { signal });

  function setActive(id) {
    if (id === activeId) return;
    rowEls.get(activeId)?.classList.remove("active");
    activeId = id;
    rowEls.get(id)?.classList.add("active");
  }

  render();
  return { setActive, render };
}
