// panel.js -- the place navigator: city switcher + searchable place tree.
// ONLY navigates. Clicking fires onSelect(node) (app.js flies the camera and
// highlights); hovering fires onHover(node|null). No ripple filtering --
// district admission stays retired (v2.2 spec Q4-A).

// There is deliberately NO hardcoded city or district list here. The old
// CITY_ORDER = ["Helsinki","Espoo","Vantaa","Kauniainen"] made this panel
// render nothing for Berlin even when Berlin had data.

import { filterRows, flattenTree } from "./places.js?v=3abff76c3a";
import { countriesOf, countryOfSlug, filterCities } from "./cities.js?v=3abff76c3a";

// Below this many rows a search box is noise rather than help.
const SEARCH_MIN_ROWS = 15;

// Below this many COUNTRIES the filter row is noise too -- with 3 countries the
// chips are just a second, worse copy of the city row. Same judgement as
// SEARCH_MIN_ROWS, applied to the axis above it.
const COUNTRY_MIN = 4;

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
    '  <div id="dp-countries" role="group" aria-label="Filter cities by country" hidden></div>' +
    '  <div id="dp-cities" role="group" aria-label="City"></div>' +
    '  <input id="dp-search" type="search" placeholder="Search places" ' +
    '         aria-label="Search places" hidden>' +
    '  <div id="dp-list" role="listbox"></div>' +
    "</div>";

  const tabEl = rootEl.querySelector("#dp-tab");
  const bodyEl = rootEl.querySelector("#dp-body");
  const countriesEl = rootEl.querySelector("#dp-countries");
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

  // `cities` arrives as a bare array from app.js; the country helpers take the
  // registry SHAPE ({cities: [...]}), so wrap once rather than teaching every
  // helper two input shapes.
  const registry = { cities: cities || [] };
  const countries = countriesOf(registry);

  // Open on the active city's country so the filter never boots hiding the city
  // currently on screen. Null = "All".
  let country = countries.length >= COUNTRY_MIN
    ? countryOfSlug(registry, activeSlug)
    : null;

  function renderCountries() {
    countriesEl.textContent = "";
    // With too few countries the row is noise -- and staying hidden means
    // `country` is never read, so every city renders.
    if (countries.length < COUNTRY_MIN) {
      countriesEl.hidden = true;
      return;
    }
    countriesEl.hidden = false;

    const chip = (label, value, count) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dp-country";
      // A count of 1 is noise: with today's one-city-per-country roster every
      // chip would read "Italy 1". Show the number only where it means
      // something -- i.e. once a country actually holds more than one city.
      b.textContent = count > 1 ? `${label} ${count}` : label;
      const on = country === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => {
        // Re-clicking the active country clears it: the chips double as their
        // own reset, so "All" is never the only way back.
        country = country === value ? null : value;
        renderCountries();
        renderCities();
      }, { signal });
      countriesEl.appendChild(b);
    };

    // "All" always carries its total -- that number is the roster size, which
    // is worth stating even at 1. Per-country counts are suppressed at 1 above.
    chip(`All ${registry.cities.length}`, null, 0);
    for (const { country: name, count } of countries) {
      chip(name === null ? "Other" : name, name, count);
    }
  }

  function renderCities() {
    citiesEl.textContent = "";
    for (const city of filterCities(registry, country)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dp-cityswitch";
      b.textContent = city.display_name;
      b.classList.toggle("active", city.slug === activeSlug);
      b.addEventListener("click", () => onCity(city.slug), { signal });
      citiesEl.appendChild(b);
    }
  }

  renderCountries();
  renderCities();

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
