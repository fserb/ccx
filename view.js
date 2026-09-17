// The listing as a UI sees it: what order the rows go in, and what colour they are. Shared
// because a terminal and a web page have no drawing layer left in common.

import {byCodePoint} from "./sh.js";

const STATE_ORDER = {wait: 0, busy: 1, free: 2};
export const SORTS = ["state", "path"];

// Subsequence match, {score, idx} or null; lowest score wins. Greedy forward to prove the
// match exists, then greedy backward from the last hit, which pulls the characters as far
// right as they go: "cx" collapses onto the trailing `cx` of ~/prj/ccx, not the c before
// it. A skipped character costs 2, or 1 at a word start, so a match at the head of a path
// segment beats one buried mid-word.
export function fuzzy(needle, hay) {
  const low = hay.toLowerCase();
  const idx = [];
  let at = 0;
  for (const c of needle) {
    at = low.indexOf(c, at);
    if (at < 0) return null;
    idx.push(at);
    at += 1;
  }
  for (let n = idx.length - 2; n >= 0; n--) {
    idx[n] = low.lastIndexOf(needle[n], idx[n + 1] - 1);
  }
  let score = 0;
  for (let n = 0; n < idx.length; n++) {
    const i = idx[n];
    const gap = n ? i - idx[n - 1] - 1 : i;
    score += gap * (i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1]) ? 1 : 2);
  }
  return {score, idx};
}

// The list in display order, which both UIs want identically. Longest stuck goes on top
// within a state. A filter outranks the sort entirely: you typed those keys to reach one
// row, so the closest match goes first and enter takes it, with the sort breaking ties.
export function rank(instances, needle = "", sort = "state") {
  const cmp = sort === "state"
    ? (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.since - b.since
    : (a, b) => byCodePoint(a.shortPath, b.shortPath) || a.pid - b.pid;
  if (!needle) return [...instances].sort(cmp);
  const scored = [];
  for (const i of instances) {
    const hits = [fuzzy(needle, i.shortPath), fuzzy(needle, i.summary)].filter((h) => h);
    if (hits.length) scored.push([Math.min(...hits.map((h) => h.score)), i]);
  }
  return scored.sort((a, b) => a[0] - b[0] || cmp(a[1], b[1])).map((p) => p[1]);
}

// Shared, since a terminal and a web page have no drawing layer left in common. Nothing
// is above the gold by relative luminance, which is what makes a `wait` row findable
// without reading it: gold .69, the wait summary .68, busy .39, every other summary .23,
// free and the number and age columns .12. #ffd500 is one shade deeper than xterm 220, the
// exact color Claude Code paints "⏵⏵ auto mode on" with.
export const STATE = {
  wait: {label: "● wait", color: "#ffd500"},
  ask: {label: "◆ wait", color: "#ffd500"},
  busy: {label: "◐ busy", color: "#93aeaa"},
  free: {label: "◌ free", color: "#626262"},
};

// The STATE entry a row draws with. `ask` is a fourth glyph and not a fourth state: it
// sorts, counts and rings as `wait`, and separates a dialog holding the screen from the
// turn merely being over. ◆ U+25C6 is East Asian Ambiguous like ●, so kitty draws it
// narrow and `◆ wait` is 6 cells; a Wide glyph would push the whole row one cell out.
export function stateOf(inst) {
  if (inst.state === "wait" && inst.asking) return STATE.ask;
  return STATE[inst.state] ?? STATE.free;
}

// Out of ~/.config/kitty/kitty.conf, so the tools look like the terminal they run in:
// #ceaadf is color13, #b8a0be is color5. `bar` and `panelBg` are two surfaces and the one
// shade between them is not a mistake: the TUI's top bar sits on a #000 screen, while the
// systray panel floats over the desktop.
export const PALETTE = {
  accent: "#ceaadf", mauve: "#b8a0be", dim: "#626262", text: "#d6d6dc",
  bg: "#000000", bar: "#181020", panelBg: "#0e0b12", edge: "#35284a", cursor: "#2a1e38",
  gold: "#ffd500", idle: "#82828a", hint: "#4a4a55", error: "#df6565",
};

// the digits label the first ten rows, in the order they are drawn
export const NUMBERS = "1234567890";
