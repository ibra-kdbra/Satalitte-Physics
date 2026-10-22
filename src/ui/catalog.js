// "Real satellites" view: CelesTrak groups with toggles, a search field and a
// quiet data-source line. Renders plain data; reports intent through handlers:
//   onCatalogToggle(groupId, on), onCatalogSearch(query), onSelect(id), onFocus(id)
import { h, textSlot, call, nextId, toggleClass } from './dom.js';
import { fmtInt } from './format.js';

const SEARCH_DEBOUNCE = 150;
const MAX_RESULTS = 8;

/** "just now", "12 min", "3 h", "4 d" for a duration in seconds (sign ignored). */
export function fmtAge(seconds) {
  const s = Math.abs(seconds);
  if (!Number.isFinite(s)) return '–';
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function createCatalogPanel(handlers) {
  const el = h('div', { class: 'catalog' });
  const searchId = nextId('catq');
  const resultsId = nextId('catr');

  // --- search ---
  const input = h('input', {
    id: searchId, class: 'search__input', type: 'search', inputmode: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Name or NORAD id', 'aria-controls': resultsId, 'aria-describedby': `${searchId}-hint`,
  });
  const resultsList = h('ul', { class: 'results', id: resultsId, role: 'list', 'aria-label': 'Search results' });
  const resultsNote = h('p', { class: 'results__note', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'results-wrap', hidden: true }, resultsNote, resultsList);
  el.append(
    h('p', { class: 'catalog__intro', text: 'Real orbits from published tracking data. Turn a group on to show it in space; click a search result to follow it.' }),
    h('div', { class: 'search' },
      h('label', { class: 'search__label', for: searchId, text: 'Find a satellite' }),
      input,
      h('p', { class: 'search__hint', id: `${searchId}-hint`, text: 'Searches the groups that are turned on.' })),
    results);

  // --- groups ---
  const groupsHead = h('h3', { class: 'group-title', text: 'Groups' });
  const groupList = h('ul', { class: 'catgroups', role: 'list', 'aria-label': 'Satellite groups' });
  const emptyGroups = h('p', { class: 'empty-line', text: 'Loading the list of groups…' });
  const sourceSlot = textSlot('Data: CelesTrak');
  const source = h('p', { class: 'source', title: 'Orbital elements published by CelesTrak, propagated in your browser with SGP4' }, sourceSlot.node);
  el.append(groupsHead, emptyGroups, groupList, source);

  const rows = new Map();
  let updated = null;
  let sourceName = 'CelesTrak';
  const colorOf = new Map();

  function makeRow(g) {
    const id = nextId('grp');
    const swatch = h('span', { class: 'swatch' });
    const name = textSlot('');
    const count = textSlot('');
    const state = textSlot('');
    const toggle = h('input', { class: 'switch', type: 'checkbox', id, role: 'switch' });
    const stateEl = h('span', { class: 'catgroup__state' }, state.node);
    const li = h('li', { class: 'catgroup' },
      h('label', { class: 'catgroup__main', for: id },
        swatch,
        h('span', { class: 'catgroup__name' }, name.node),
        h('span', { class: 'catgroup__count num' }, count.node),
        stateEl),
      toggle);
    toggle.addEventListener('change', () => call(handlers.onCatalogToggle, li.dataset.id, toggle.checked));
    return { li, swatch, name, count, state, stateEl, toggle, last: {} };
  }

  function updateRow(r, g) {
    const L = r.last;
    r.li.dataset.id = g.id;
    if (L.name !== g.name) {
      L.name = g.name;
      r.name.set(g.name || g.id);
      r.toggle.setAttribute('aria-label', `Show ${g.name || g.id}`);
    }
    if (L.color !== g.color) { L.color = g.color; r.swatch.style.setProperty('--c', g.color || '#8d97a6'); }
    const countText = Number.isFinite(g.count) ? fmtInt(g.count) : '';
    r.count.set(countText);
    r.li.title = Number.isFinite(g.count) ? `${fmtInt(g.count)} satellites` : '';
    if (r.toggle.checked !== !!g.visible) r.toggle.checked = !!g.visible;
    let st = '';
    let kind = '';
    if (g.error) { st = String(g.error); kind = 'error'; }
    else if (g.loading) { st = 'Loading…'; kind = 'loading'; }
    r.state.set(st);
    if (r.stateEl.dataset.kind !== kind) r.stateEl.dataset.kind = kind;
    r.stateEl.hidden = !st;
    toggleClass(r.li, 'is-on', !!g.visible);
    r.li.setAttribute('aria-busy', g.loading ? 'true' : 'false');
  }

  function renderSource() {
    if (!updated) { sourceSlot.set(`Data: ${sourceName} (live)`); return; }
    const age = (Date.now() - updated.getTime()) / 1000;
    sourceSlot.set(`Data: ${sourceName} · updated ${fmtAge(age) === 'just now' ? 'just now' : `${fmtAge(age)} ago`}`);
  }

  function setCatalog({ groups = [], updated: up = null, source: src } = {}) {
    sourceName = src || 'CelesTrak';
    updated = up instanceof Date && !Number.isNaN(up.getTime()) ? up : up ? new Date(up) : null;
    if (updated && Number.isNaN(updated.getTime())) updated = null;
    renderSource();
    const seen = new Set();
    let i = 0;
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || g.id == null) continue;
      const id = String(g.id);
      seen.add(id);
      colorOf.set(id, g.color);
      let r = rows.get(id);
      if (!r) { r = makeRow(g); rows.set(id, r); }
      updateRow(r, { ...g, id });
      const at = groupList.children[i];
      if (at !== r.li) groupList.insertBefore(r.li, at || null);
      i++;
    }
    for (const [id, r] of rows) if (!seen.has(id)) { r.li.remove(); rows.delete(id); }
    emptyGroups.hidden = rows.size > 0;
  }

  // --- search behaviour ---
  let timer = 0;
  let lastQuery = '';
  let pending = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      lastQuery = '';
      pending = '';
      results.hidden = true;
      resultsList.replaceChildren();
      return;
    }
    timer = setTimeout(() => {
      pending = q;
      resultsNote.textContent = 'Searching…';
      results.hidden = false;
      call(handlers.onCatalogSearch, q);
    }, SEARCH_DEBOUNCE);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = resultsList.querySelector('button');
      if (first) first.click();
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } else if (e.key === 'ArrowDown') {
      const first = resultsList.querySelector('button');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  resultsList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...resultsList.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const j = i + (e.key === 'ArrowDown' ? 1 : -1);
    if (j < 0) input.focus(); else if (btns[j]) btns[j].focus();
  });

  function swatchFor(group) {
    const sw = h('span', { class: 'swatch' });
    sw.style.setProperty('--c', colorOf.get(String(group)) || '#8d97a6');
    return sw;
  }

  function setSearchResults(query, list) {
    const q = String(query ?? '').trim();
    // ignore stale replies
    if (q !== (pending || input.value.trim())) return;
    lastQuery = q;
    const arr = Array.isArray(list) ? list : [];
    resultsList.replaceChildren(...arr.slice(0, MAX_RESULTS).map((r) => h('li', null,
      h('button', {
        class: 'result', type: 'button', dataset: { id: r.id },
        'aria-label': `${r.name}, NORAD ${r.norad}${r.groupName ? `, ${r.groupName}` : ''}: select and follow`,
        onclick: () => { call(handlers.onSelect, r.id); call(handlers.onFocus, r.id); },
      },
      swatchFor(r.group),
      h('span', { class: 'result__name', text: r.name }),
      h('span', { class: 'result__meta' }, h('span', { class: 'num', text: String(r.norad ?? '') }), r.groupName ? ` · ${r.groupName}` : '')))));
    if (!arr.length) resultsNote.textContent = `No match for “${q}” in the groups that are on.`;
    else if (arr.length > MAX_RESULTS) resultsNote.textContent = `${fmtInt(arr.length)} matches · showing ${MAX_RESULTS}`;
    else resultsNote.textContent = arr.length === 1 ? '1 match' : `${arr.length} matches`;
    results.hidden = false;
  }

  return {
    element: el,
    setCatalog,
    setSearchResults,
    /** refresh the relative "updated … ago" text (cheap; call occasionally) */
    tick: renderSource,
    get query() { return lastQuery; },
  };
}
