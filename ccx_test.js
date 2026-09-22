// `deno test -A --ext=js ccx_test.js`. Nothing here touches live state: no discover(), no
// tmux, no ~/.claude. The library is imported, the renderer is driven as a subprocess, and
// the icon and the bell are pure.

import {fmtAge, Instance, paneState, StateClock, summaryOf} from "./claudes.js";
import {fuzzy, NUMBERS, PALETTE, rank, SORTS, STATE} from "./view.js";
import {loadBell, soundBytes} from "./bell.js";
import {iconDots, iconPng} from "./icon.js";
import {baseFromSettings, Online, pickBase} from "./online.js";

// assertions

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

function near(got, want, eps, what) {
  if (!(Math.abs(got - want) <= eps)) {
    throw new Error(`${what}: got ${got}, want ${want} +/- ${eps}`);
  }
}

// the fixtures

let nextPid = 100;
const row = (state, since, shortPath, summary = "", pid = nextPid++) =>
  ({state, since, shortPath, summary, pid});

// written out of Unicode's EastAsianWidth, not copied from the renderer, so a bug in its
// table is not also a bug here. Ambiguous counts NARROW, which is how kitty draws it
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯！-｠￠-￦]/u;

const width = (s) =>
  [...s].reduce((n, c) => n + (WIDE.test(c) || c.codePointAt(0) >= 0x1f300 ? 2 : 1), 0);

// fuzzy

Deno.test("fuzzy: a subsequence matches, and a missing character does not", () => {
  ok(fuzzy("wrng", "~/prj/wrangler"), "wrng should find ~/prj/wrangler");
  eq(fuzzy("zq", "~/prj/ccx"), null, "a character not in the hay");
  eq(fuzzy("xc", "~/prj/ccx"), null, "the right characters in the wrong order");
  eq(fuzzy("", "~/prj/ccx"), {score: 0, idx: []}, "an empty needle matches everything");
});

Deno.test("fuzzy: wrng lands on the letters of wrangler", () => {
  //             0123456789...
  const hay = "~/prj/wrangler";
  eq(fuzzy("wrng", hay).idx, [6, 7, 9, 10], "idx");
  eq([...fuzzy("wrng", hay).idx].map((i) => hay[i]).join(""), "wrng", "the matched text");
  // 6 to reach the w, x1 because a `/` precedes it, then 1 skipped `a` inside a word at x2
  eq(fuzzy("wrng", hay).score, 8, "score");
});

Deno.test("fuzzy: cx collapses onto the TRAILING cx of ~/prj/ccx", () => {
  const hay = "~/prj/ccx";      // indices 6, 7, 8 are c, c, x
  eq(fuzzy("cx", hay).idx, [7, 8], "the backward pass must take the second c, not the first");
});

Deno.test("fuzzy: the hay is matched case-insensitively", () => {
  eq(fuzzy("cx", "~/PRJ/CCX").idx, [7, 8], "upper case hay");
  // the needle is not lowered here: both UIs lower it before they call
  eq(fuzzy("CX", "~/prj/ccx"), null, "the caller owns lowering the needle");
});

Deno.test("fuzzy: a skipped character costs 2, or 1 at a word start", () => {
  eq(fuzzy("ab", "a-b").score, 1, "the skipped character is a word boundary");
  eq(fuzzy("ab", "axb").score, 2, "the skipped character is inside a word");
});

Deno.test("fuzzy: a match at a path-segment head beats one buried mid-word", () => {
  const head = fuzzy("w", "~/prj/-w").score;     // the w follows a non-alphanumeric
  const buried = fuzzy("w", "~/prj/xw").score;   // the w follows a letter
  eq(head, 7, "head of a segment: 7 skipped cells at x1");
  eq(buried, 14, "mid-word: the same 7 cells at x2");
  ok(head < buried, "lowest score wins, so the segment head must rank first");
});

Deno.test("fuzzy: a prefix costs nothing", () => {
  eq(fuzzy("~/p", "~/prj/ccx"), {score: 0, idx: [0, 1, 2]}, "an exact prefix");
});

// rank

Deno.test("rank: state puts wait before busy before free", () => {
  const rows = [row("free", 0, "~/a"), row("busy", 0, "~/b"), row("wait", 0, "~/c")];
  eq(rank(rows, "", "state").map((i) => i.state), ["wait", "busy", "free"], "state order");
});

Deno.test("rank: within a state the one stuck there longest goes on top", () => {
  const rows = [
    row("wait", 500, "~/new"), row("wait", 100, "~/old"), row("wait", 300, "~/mid"),
  ];
  eq(rank(rows, "", "state").map((i) => i.shortPath), ["~/old", "~/mid", "~/new"],
    "smallest `since` first: that is the oldest transition");
});

Deno.test("rank: path sorts by code point, not by locale", () => {
  const rows = [row("wait", 0, "~/apple"), row("wait", 0, "~/Banana")];
  eq(rank(rows, "", "path").map((i) => i.shortPath), ["~/Banana", "~/apple"],
    "B is 0x42 and a is 0x61");
  // the two orders really do differ, so this is not a coincidence
  ok("~/apple".localeCompare("~/Banana") < 0,
    "localeCompare would have put apple first; code point must not");
});

Deno.test("rank: path breaks a tie on pid", () => {
  const rows = [row("wait", 0, "~/same", "", 50), row("busy", 0, "~/same", "", 7)];
  eq(rank(rows, "", "path").map((i) => i.pid), [7, 50], "lower pid first");
});

Deno.test("rank: a needle outranks the sort", () => {
  const good = row("free", 0, "~/prj/ccx");        // scores 6 on "ccx"
  const worse = row("wait", 0, "~/prj/c-c-x");     // scores 8: two skipped characters
  eq(rank([good, worse], "", "state").map((i) => i.state), ["wait", "free"],
    "with no needle the wait row is first");
  eq(rank([good, worse], "ccx", "state").map((i) => i.shortPath), ["~/prj/ccx", "~/prj/c-c-x"],
    "with a needle the closer match is first, whatever its state");
});

Deno.test("rank: a needle drops what does not match", () => {
  const rows = [row("wait", 0, "~/prj/ccx"), row("wait", 0, "~/blah")];
  eq(rank(rows, "ccx", "state").map((i) => i.shortPath), ["~/prj/ccx"], "one survivor");
  eq(rank(rows, "zzz", "state"), [], "nothing matches");
});

Deno.test("rank: ties fall back to the sort", () => {
  // identical text, so identical scores; only the sort can order them
  const free = row("free", 0, "~/prj/ccx", "", 1);
  const wait = row("wait", 0, "~/prj/ccx", "", 2);
  eq(rank([free, wait], "ccx", "state").map((i) => i.pid), [2, 1], "state breaks the tie");
  eq(rank([free, wait], "ccx", "path").map((i) => i.pid), [1, 2], "path breaks it on pid");
});

Deno.test("rank: the needle matches the summary as well as the path", () => {
  const rows = [row("wait", 0, "~/x", "reorganize the skills tree"), row("wait", 0, "~/y")];
  eq(rank(rows, "skills", "state").map((i) => i.shortPath), ["~/x"], "matched on summary");
});

Deno.test("rank: the input list is not reordered", () => {
  const rows = [row("free", 0, "~/a"), row("wait", 0, "~/b")];
  const before = rows.map((i) => i.shortPath);
  rank(rows, "", "state");
  eq(rows.map((i) => i.shortPath), before, "rank must copy before it sorts");
});

Deno.test("SORTS is the two sorts the UIs cycle", () => {
  eq(SORTS, ["state", "path"], "SORTS");
  eq(NUMBERS, "1234567890", "the digits label the first ten rows in draw order");
});

// fmtAge etc

Deno.test("fmtAge: seconds, then minutes, then hours", () => {
  eq([0, 1, 59, 60, 61, 3599, 3600, 7199, 86400].map(fmtAge),
    ["0s", "1s", "59s", "1m", "1m", "59m", "1h", "1h", "24h"], "fmtAge");
  eq(fmtAge(-5), "0s", "a clock skew must not print a negative age");
});

Deno.test("Instance: shortPath abbreviates HOME and carries the tab", () => {
  const home = Deno.env.get("HOME");
  eq(new Instance({path: `${home}/prj/ccx`}).shortPath, "~/prj/ccx", "HOME becomes ~");
  eq(new Instance({path: `${home}/prj/ccx`, tab: "2"}).shortPath, "~/prj/ccx:2",
    "the tmux window index is appended only when there is one");
  eq(new Instance({path: "/tmp/x"}).shortPath, "/tmp/x", "a path outside HOME is untouched");
  eq(new Instance({}).shortPath, "?", "no path at all");
});

Deno.test("Instance: match is kitty's pid: form, or null with no kitty ancestor", () => {
  eq(new Instance({kittyPid: "4242"}).match, "pid:4242", "the direct child of kitty");
  eq(new Instance({}).match, null, "nothing to match on");
});

// the palette rule

// WCAG relative luminance: linearize each sRGB channel, then 0.2126/0.7152/0.0722
function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

Deno.test("colors: the documented luminances are what the hexes are", () => {
  near(luminance(STATE.wait.color), 0.69, 0.005, "wait gold #ffd500");
  near(luminance(PALETTE.text), 0.68, 0.005, "the wait row's summary #d6d6dc");
  near(luminance(STATE.busy.color), 0.39, 0.005, "busy #93aeaa");
  near(luminance(PALETTE.idle), 0.23, 0.005, "every other summary #82828a");
  near(luminance(STATE.free.color), 0.12, 0.005, "free #626262");
  near(luminance(PALETTE.dim), 0.12, 0.005, "the number and age columns #626262");
});

Deno.test("colors: nothing on either screen is brighter than the gold", () => {
  const gold = luminance(PALETTE.gold);
  eq(PALETTE.gold, STATE.wait.color, "the wait label and the gold are the same color");
  for (const [name, hex] of Object.entries(PALETTE)) {
    ok(luminance(hex) <= gold + 1e-12, `PALETTE.${name} ${hex} is brighter than the gold`);
  }
  for (const [name, {color}] of Object.entries(STATE)) {
    ok(luminance(color) <= gold + 1e-12, `STATE.${name} ${color} is brighter than the gold`);
  }
});

Deno.test("colors: the state labels are 6 cells, which is the state column's width", () => {
  for (const [name, {label}] of Object.entries(STATE)) {
    eq(width(label), 6, `${name} label "${label}" must fill the 6-wide state cell exactly`);
  }
});

// the frame
// `ccx` cannot be imported: --ext is for the entry point only, and the module runs the CLI
// and calls Deno.exit() on load, so it is driven as a subprocess. Frames are cached, one
// process per (cols, rows, flags) however many tests read it

const CCX = new URL("./ccx", import.meta.url).pathname;
const FRAMES = new Map();

async function snapshot(...args) {
  const key = args.join(" ");
  if (!FRAMES.has(key)) {
    const {code, stdout, stderr} = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--ext=js", CCX, "--snapshot", ...args],
    }).output();
    const out = new TextDecoder().decode(stdout);
    if (code !== 0) {
      throw new Error(`ccx --snapshot ${key} exited ${code}: ` +
        new TextDecoder().decode(stderr));
    }
    FRAMES.set(key, out.replace(/\n$/, "").split("\n"));
  }
  return FRAMES.get(key);
}

// one entry per display cell: a two-cell character owns its cell and an empty one after it
function cellsOf(line) {
  const out = [];
  for (const c of line) {
    out.push(c);
    if (width(c) === 2) out.push("");
  }
  return out;
}

const at = (line, n, len = 1) => cellsOf(line).slice(n, n + len).join("");

// 0-based display cells, the table body's own positions plus the one-cell left margin
const NUM = 2, STATE_COL = 5, FOR = 13, PATH = 20, SUMMARY = 48;
const PATH_W = 26, SUMMARY_W = 50;

// SAMPLE in `ccx` after rank(): waits oldest-first, then busys, then free. Mirrored here
// on purpose, so changing the fixture fails loudly instead of weakening the test
const ROWS = [
  ["● wait", "5m", "~/prj/kanji", "日本語のタイトル in a session title"],
  ["● wait", "42s", "~/prj/ccx", "port ccx from python to deno"],
  ["◆ wait", "7s", "~/blah", "reorganize the skills tree"],
  ["◐ busy", "25m", "~/prj/ccx:2", "inline the bell and play it from memory"],
  ["◐ busy", "3m", "~/prj/wrangler", "wrangler config for the edge worker"],
  ["◐ busy", "1m", "~/prj/a-very-long-director",
    "a summary that is definitely longer than fifty dis"],   // both cropped, hard
  ["◌ free", "2h", "~/web/blob2", ""],
];
const HEAD = 3;                 // bar, rule, header, then the rows

Deno.test("snapshot: the content sits at cells 2, 5, 13, 20 and 48", async () => {
  const frame = await snapshot("100x14", "plain");
  eq(at(frame[2], STATE_COL, 5), "state", "the state header");
  eq(at(frame[2], FOR, 3), "for", "the for header");
  eq(at(frame[2], PATH, 4), "path", "the path header");
  eq(at(frame[2], SUMMARY, 7), "summary", "the summary header");

  ROWS.forEach(([label, age, path, summary], n) => {
    const line = frame[HEAD + n];
    eq(at(line, NUM), NUMBERS[n], `row ${n}: the digit`);
    eq(at(line, STATE_COL, 6), label, `row ${n}: the state cell`);
    eq(at(line, FOR, age.length), age, `row ${n}: the age`);
    eq(at(line, PATH, width(path)), path, `row ${n}: the path`);
    eq(at(line, SUMMARY, width(summary)), summary, `row ${n}: the summary`);
  });
});

Deno.test("snapshot: the gaps between the columns are two cells", async () => {
  const frame = await snapshot("100x14", "plain");
  for (const line of frame.slice(HEAD, HEAD + ROWS.length)) {
    for (const n of [1, 3, 4, 11, 12, 18, 19, 46, 47]) {
      eq(at(line, n), " ", `cell ${n} is a column gap or a margin`);
    }
  }
});

Deno.test("snapshot: the japanese row's summary starts where the ascii rows' do", async () => {
  const frame = await snapshot("100x14", "plain");
  const kanji = frame[HEAD];
  eq(at(kanji, SUMMARY, 2), "日", "the summary column, counted in cells");
  // 100 cells holding eight two-cell characters is 92 code points; counting UTF-16 units
  // would pad to 100 code points, 108 cells, and throw this row's summary out of line
  eq([...kanji].length, 92, "code points in the japanese row");
  eq(width(kanji), 100, "display cells in the japanese row");
});

Deno.test("snapshot: every line is exactly as wide as the screen", async () => {
  for (const size of ["100x14", "46x14", "200x14"]) {
    const cols = Number(size.split("x")[0]);
    for (const [n, line] of (await snapshot(size, "plain")).entries()) {
      eq(width(line), cols, `${size} line ${n} must not run off the right edge`);
    }
  }
});

Deno.test("snapshot: a path crops hard at 26 cells and a summary at 50", async () => {
  const frame = await snapshot("100x14", "plain");
  const line = frame[HEAD + 5];                 // the over-long fixture row
  eq(at(line, PATH, PATH_W), "~/prj/a-very-long-director", "26 cells of path, no more");
  eq(at(line, PATH + PATH_W), " ", "and then the column gap");
  eq(at(line, SUMMARY, SUMMARY_W), "a summary that is definitely longer than fifty dis",
    "50 cells of summary");
  eq(width(at(line, PATH, PATH_W)), PATH_W, "the path cell is full");
  eq(width(at(line, SUMMARY, SUMMARY_W)), SUMMARY_W, "the summary cell is full");
});

Deno.test("snapshot: cropping leaves no ellipsis anywhere", async () => {
  for (const size of ["100x14", "46x14"]) {
    for (const line of await snapshot(size, "plain")) {
      ok(!line.includes("…"), `${size}: a horizontal ellipsis in "${line.trim()}"`);
      ok(!line.includes("..."), `${size}: three dots in "${line.trim()}"`);
    }
  }
});

Deno.test("snapshot: the empty state is a note across the table, not in the state cell",
  async () => {
    const frame = await snapshot("100x14", "plain", "empty");
    const note = frame[HEAD];
    eq(at(note, STATE_COL, 19), "no claude instances",
      "the line starts at the state column and runs past its 6-wide cell uncropped");
    eq(at(note, STATE_COL - 1), " ", "nothing before it");
    eq(width(note), 100, "and it is still a full line");
  });

Deno.test("snapshot: a filter that matches nothing says so", async () => {
  const frame = await snapshot("100x14", "plain", "/zz");
  eq(at(frame[HEAD], STATE_COL, 27), "nothing matches that filter", "the note");
  ok(frame[0].includes("0 of 7"), `the bar counts the survivors: "${frame[0].trim()}"`);
});

Deno.test("snapshot: more rows than fit gets a count, not a scrollbar", async () => {
  const frame = await snapshot("100x8", "plain");
  eq(frame.length, 8, "the frame is exactly as tall as the screen");
  // 8 lines: bar, rule, header, 4 rows, and the last line says what is hidden
  eq(at(frame[7], STATE_COL, 6), "3 more", "3 of the 7 rows are not drawn");
  eq(at(frame[HEAD], NUM), "1", "the first row is still drawn");
});

Deno.test("snapshot: the toast takes the last line, right aligned", async () => {
  const frame = await snapshot("100x14", "plain", "toast");
  const last = frame[frame.length - 1];
  ok(last.trimEnd().endsWith("nothing to focus"), `the toast text: "${last.trim()}"`);
  eq(width(last), 100, "still a full line");
  eq((await snapshot("100x14", "plain")).at(-1).trim(), "",
    "without the flag that line is blank");
});

Deno.test("snapshot: a filter reorders and the digits follow the drawn order", async () => {
  const frame = await snapshot("100x14", "plain", "/ccx");
  eq(at(frame[HEAD], NUM), "1", "the first row is numbered 1");
  eq(at(frame[HEAD], PATH, 9), "~/prj/ccx", "the closest match is first");
  eq(at(frame[HEAD + 1], NUM), "2", "the second row is numbered 2");
});

// the icon
// every count 0 to 25 in every (wait, busy, free) split, in the order rank() hands them
// over: 3276 cases

const BOX = 18;                 // the icon is drawn into 18pt inside the menu bar's 22
const EPS = 1e-9;

function* mixes(max = 25) {
  for (let n = 0; n <= max; n++) {
    for (let w = 0; w <= n; w++) {
      for (let b = 0; b <= n - w; b++) {
        yield [
          ...Array(w).fill("wait"), ...Array(b).fill("busy"), ...Array(n - w - b).fill("free"),
        ];
      }
    }
  }
}

// read off the dots, not recomputed: the first two of any grid are side by side
const pitch = (spots) => (spots.length > 1 ? spots[1].cx - spots[0].cx : BOX / 2);

Deno.test("icon: the grid is the smallest square that holds the dots, floor 2x2", () => {
  const cell = (n) => pitch(iconDots(Array(n).fill("busy")));
  near(cell(1), 9, EPS, "one dot still sits in a 2x2, or it is a blob");
  near(cell(2), 9, EPS, "two make a 2x2");
  near(cell(3), 9, EPS, "three make a 2x2 with a hole in it");
  near(cell(4), 9, EPS, "four fill the 2x2");
  near(cell(5), 6, EPS, "five make a 3x3");
  near(cell(16), 4.5, EPS, "sixteen make a 4x4");
  near(cell(17), 3.6, EPS, "seventeen make a 5x5");
  near(cell(25), 3.6, EPS, "and so do twenty-five");
});

Deno.test("icon: a wait dot is 80% of its cell and every other 62%", () => {
  const two = iconDots(["wait", "busy"]);
  near(two[0].r, 9 * 0.80 / 2, EPS, "the wait dot");
  near(two[1].r, 9 * 0.62 / 2, EPS, "the busy dot");
  near(two[0].r - two[1].r, 0.81, EPS, "+0.81pt of radius in a 2x2");
  const sixteen = iconDots(["wait", ...Array(15).fill("busy")]);
  near(sixteen[0].r - sixteen[1].r, 0.405, EPS, "+0.41pt in a 4x4, as the doc rounds it");
  // a fraction of the cell and not a fixed bump, which is what keeps it safe at any size
  for (const n of [1, 5, 16, 17, 25]) {
    const spots = iconDots(["wait", ...Array(n - 1).fill("free")]);
    near(spots[0].r / (pitch(spots) / 2), 0.80, EPS, `n=${n}: the wait dot's fill`);
  }
});

Deno.test("icon: zero instances is one centered ring's worth of space", () => {
  const spots = iconDots([]);
  eq(spots.length, 1, "something to click on");
  near(spots[0].cx, BOX / 2, EPS, "centered horizontally");
  near(spots[0].cy, BOX / 2, EPS, "centered vertically");
  near(spots[0].r, 9 * 0.62 / 2, EPS, "at the ordinary dot's radius");
});

Deno.test("icon: 3276 mixes, and the four numbers the doc records", () => {
  let cases = 0;
  let minGap = Infinity, gapAt = 0;
  let minClear = Infinity, clearAt = 0;
  let maxBlockSkew = 0, maxUniformInk = 0, maxLean = 0, leanAt = 0;

  for (const states of mixes()) {
    cases++;
    const n = states.length;
    const spots = iconDots(states, BOX);
    eq(spots.length, Math.max(n, 1), `n=${n}: one spot per instance, floor 1`);
    if (!n) continue;

    const cell = pitch(spots);
    near(BOX / cell, Math.round(BOX / cell), EPS, `n=${n}: the pitch divides the box`);
    const grid = Math.round(BOX / cell);
    const cols = Math.min(n, grid), rows = Math.ceil(n / grid);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = spots[i], b = spots[j];
        const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;
        if (gap < minGap) [minGap, gapAt] = [gap, n];
      }
    }
    for (const {cx, cy, r} of spots) {
      const clear = Math.min(cx - r, cy - r, BOX - cx - r, BOX - cy - r);
      if (clear < minClear) [minClear, clearAt] = [clear, n];
    }

    // the BLOCK OF CELLS the dots use is what is centered, not the whole grid
    const blockLeft = spots[0].cx - cell / 2, blockTop = spots[0].cy - cell / 2;
    maxBlockSkew = Math.max(maxBlockSkew,
      Math.abs(blockLeft - (BOX - blockLeft - cols * cell)),
      Math.abs(blockTop - (BOX - blockTop - rows * cell)));

    // the ink itself, once with one radius everywhere and once as the mix really is
    const lean = (list) => {
      const l = Math.min(...list.map((s) => s.cx - s.r));
      const rr = Math.max(...list.map((s) => s.cx + s.r));
      const t = Math.min(...list.map((s) => s.cy - s.r));
      const bb = Math.max(...list.map((s) => s.cy + s.r));
      return Math.max(Math.abs(l - (BOX - rr)), Math.abs(t - (BOX - bb)));
    };
    maxUniformInk = Math.max(maxUniformInk, lean(iconDots(Array(n).fill("free"), BOX)));
    const mixed = lean(spots);
    if (mixed > maxLean) [maxLean, leanAt] = [mixed, n];
  }

  eq(cases, 3276, "every (wait, busy, free) split of every count from 0 to 25");
  near(minGap, 0.72, EPS, "tightest gap between two dots");
  eq(gapAt, 17, "which first happens at n=17, the first 5x5");
  near(minClear, 0.36, EPS, "worst clearance to the box edge: nothing ever crosses");
  eq(clearAt, 17, "also at n=17");
  ok(maxBlockSkew < EPS, `cell-block centering skew ${maxBlockSkew} is not float noise`);
  ok(maxUniformInk < EPS, `ink centering with uniform radii ${maxUniformInk} is not float noise`);
  near(maxLean, 0.81, EPS, "ink lean, mixed wait and other");
  eq(leanAt, 2, "the widest cell is the 2x2, so that is where the lean is worst");
  ok(maxLean < 9 * 0.62 / 2, "and it stays under half a free dot, 2.79pt");
});

// the icon png

// only the filter-0, 8-bit RGBA form `png()` writes, enough to read the ink back
async function decodePng(bytes) {
  eq([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "the PNG signature");
  const text = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  let at = 8, w = 0, h = 0;
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = text.decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      const ihdr = new DataView(data.buffer, data.byteOffset, data.byteLength);
      [w, h] = [ihdr.getUint32(0), ihdr.getUint32(4)];
      eq([data[8], data[9]], [8, 6], "8 bits per channel, color type 6 (RGBA)");
    }
    if (type === "IDAT") parts.push(data);
    at += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(parts).stream()
    .pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const stride = w * 4 + 1;
  eq(raw.length, stride * h, "one filter byte plus one row of RGBA per scanline");
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    eq(raw[y * stride], 0, `scanline ${y} is written with filter 0`);
    px.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * w * 4);
  }
  const pixel = (x, y) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  const ink = [...px].filter((_, n) => n % 4 === 3).reduce((a, v) => a + v / 255, 0);
  return {w, h, pixel, ink};
}

Deno.test("iconPng: a 36px 2x image, and the dots are the sizes and colors claimed",
  async () => {
    const wait = await decodePng(await iconPng(["wait"]));
    eq([wait.w, wait.h], [36, 36], "18pt at 2x");
    eq(wait.pixel(18, 18), [0xff, 0xd5, 0x00, 255], "the wait dot is the gold, opaque");
    near(wait.ink, Math.PI * 7.2 ** 2, Math.PI * 7.2 ** 2 * 0.01, "the wait dot's area");

    const busy = await decodePng(await iconPng(["busy"]));
    eq(busy.pixel(18, 18), [0xc8, 0xc8, 0xc8, 255], "busy");
    const free = await decodePng(await iconPng(["free"]));
    eq(free.pixel(18, 18), [0x8c, 0x8c, 0x8c, 255], "free");
    near(free.ink, Math.PI * 5.58 ** 2, Math.PI * 5.58 ** 2 * 0.01, "the ordinary dot's area");
    ok(wait.ink > free.ink * 1.5, "gold is bigger as well as brighter");
  });

Deno.test("iconPng: the dots keep the gold brightest, and only the slash is above it", () => {
  near(luminance("#ffd500"), 0.69, 0.005, "wait, the panel's gold");
  near(luminance("#c8c8c8"), 0.58, 0.005, "busy, brighter here than in the table");
  near(luminance("#8c8c8c"), 0.26, 0.005, "free, flat rather than translucent");
  ok(luminance("#c8c8c8") < luminance("#ffd500"), "busy under the gold");
  ok(luminance("#8c8c8c") < luminance("#c8c8c8"), "free under busy");
  // the one exception, and deliberate: the slash is not a state, it is drawn across every
  // dot colour at once, and it has to read against all of them
  ok(luminance("#ffffff") > luminance("#ffd500"), "the offline slash is above the gold");
});

Deno.test("iconPng: no instances draws a ring, with a hole in it", async () => {
  const {w, pixel, ink} = await decodePng(await iconPng([]));
  eq(w, 36, "still 36px");
  eq(pixel(18, 18)[3], 0, "the middle is empty: this is a ring, not a dot");
  // r 5.58, stroked 2.4 wide at 2x, so pi * (6.78^2 - 4.38^2)
  const area = Math.PI * (6.78 ** 2 - 4.38 ** 2);
  near(ink, area, area * 0.02, "the ring's area");
  eq(pixel(18, 12).slice(0, 3), [0x8c, 0x8c, 0x8c], "drawn in the free grey");
});

Deno.test("iconPng: offline slashes the icon, and cuts a gap either side of the line",
  async () => {
    const on = await decodePng(await iconPng(["wait"], 2, true));
    const off = await decodePng(await iconPng(["wait"], 2, false));
    // the line runs corner to corner through the middle, where the one dot is
    eq(on.pixel(18, 18), [0xff, 0xff, 0xff, 255], "the slash over the dot, white and opaque");
    eq(on.pixel(17, 17), [0xff, 0xff, 0xff, 255], "and the pixel beside it, so it is a line");
    eq(off.pixel(18, 18), [0xff, 0xd5, 0x00, 255], "the same pixel is the gold without it");
    eq(on.pixel(4, 31), [0xff, 0xff, 0xff, 255], "the bottom left end, 2.2pt in");
    eq(on.pixel(31, 4), [0xff, 0xff, 0xff, 255], "the top right end");
    eq(off.pixel(4, 31)[3], 0, "nothing is drawn out there otherwise");
    // At 45 degrees a pixel is 1.41 cells across the line, wider than the 0.6pt gap, so no
    // pixel in it is fully cleared; what the gap has to do is thin the dot under the line.
    for (const [x, y] of [[19, 19], [16, 16]]) {
      ok(on.pixel(x, y)[3] < 128, `(${x},${y}) is the gap: ${on.pixel(x, y)[3]} of 255`);
      eq(off.pixel(x, y)[3], 255, `(${x},${y}) is solid gold with no slash`);
    }
    // two pixels out and the dot is whole again: a wider slash eats the dots it crosses
    // instead of crossing them, which is what 2.4pt with a 1.1pt gap did
    for (const [x, y] of [[21, 21], [14, 14]]) {
      eq(on.pixel(x, y), [0xff, 0xd5, 0x00, 255], `(${x},${y}) is still the dot`);
    }
    ok(on.ink > off.ink, "the slash adds more ink than its gap takes away");
  });

Deno.test("iconPng: the slash is off unless it is asked for", async () => {
  const bare = await iconPng(["wait", "busy"]);
  const said = await iconPng(["wait", "busy"], 2, false);
  eq([...bare], [...said], "the default is the same image as offline: false");
});

// online

Deno.test("online: the first source that holds a URL wins, and the default is Anthropic", () => {
  eq(pickBase("", "", ""), {url: "https://api.anthropic.com", from: "default"},
    "nothing set anywhere");
  eq(pickBase("", "", "http://env").from, "$ANTHROPIC_BASE_URL", "the environment");
  eq(pickBase("", "http://user", "http://env").from, "~/.claude/settings.json",
    "a user setting outranks the environment");
  eq(pickBase("http://managed", "http://user", "http://env").url, "http://managed",
    "a managed policy outranks both");
});

Deno.test("online: a trailing slash is dropped, or the probe asks for //v1/models", () => {
  eq(pickBase("", "", "http://proxy:4000/").url, "http://proxy:4000", "one slash");
  eq(pickBase("", "", "http://proxy:4000///").url, "http://proxy:4000", "three");
});

Deno.test("online: the URL is read out of a settings file's env block", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/settings.json`;
    await Deno.writeTextFile(path, JSON.stringify({env: {ANTHROPIC_BASE_URL: " http://x "}}));
    eq(baseFromSettings(path), "http://x", "trimmed");
    await Deno.writeTextFile(path, JSON.stringify({env: {}}));
    eq(baseFromSettings(path), "", "an empty env block");
    await Deno.writeTextFile(path, '{"env": {"ANTHROPIC_BASE_URL"');
    eq(baseFromSettings(path), "", "a file caught half-written reads as unset");
    eq(baseFromSettings(`${dir}/nope.json`), "", "a missing file too");
  } finally {
    await Deno.remove(dir, {recursive: true});
  }
});

Deno.test("online: the host is named only when it is not the default", () => {
  eq(new Online(pickBase("", "", "")).label, "offline", "nothing to disambiguate");
  eq(new Online(pickBase("", "", "http://127.0.0.1:4000")).label, "offline 127.0.0.1:4000",
    "an override is worth the cells it costs");
});

// a local server, so nothing here needs the network to pass
async function served(status, fn) {
  const server = Deno.serve({port: 0, hostname: "127.0.0.1", onListen: () => {}},
    () => new Response("{}", {status}));
  const {port} = /** @type {any} */ (server.addr);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("online: an answer is up, a 5xx is down, and nothing listening is down", async () => {
  for (const status of [200, 401, 404]) {
    const r = await served(status, (url) => new Online({url, from: "test"}).probe());
    eq([r.ok, r.note], [true, `HTTP ${status}`], `${status} is the server answering`);
  }
  for (const status of [500, 503]) {
    const r = await served(status, (url) => new Online({url, from: "test"}).probe());
    eq([r.ok, r.note], [false, `HTTP ${status}`], `${status} is not`);
  }
  // a port that was listening and is not any more, so this is a refusal and not a timeout
  const dead = await served(200, (url) => url);
  const r = await new Online({url: dead, from: "test"}).probe();
  eq(r.ok, false, "nothing listening");
  ok(r.note.startsWith("TypeError"), `a thrown fetch is reported: ${r.note}`);
});

Deno.test("online: two failures draw the slash, one success clears it", () => {
  const net = new Online({url: "http://x", from: "test"});
  ok(!net.offline, "a fresh one is not offline, so a start never flashes the slash");
  net.record(false);
  ok(!net.offline, "one failure is a dropped request, not an outage");
  net.record(false);
  ok(net.offline, "two consecutive failures");
  net.record(false);
  eq(net.fails, 2, "the count is capped, so a long outage still clears on one success");
  net.record(true);
  ok(!net.offline, "and it does");
});

Deno.test("online: a probe is due every 30s, or every 5s once one has failed", () => {
  const net = new Online({url: "http://x", from: "test"});
  ok(net.due(0), "never probed, so the first tick probes");
  net.last = 1000;
  ok(!net.due(1000 + 29_000), "29s after the last one");
  ok(net.due(1000 + 30_000), "30s after it");
  net.record(false);
  ok(!net.due(1000 + 4_000), "4s, having failed");
  ok(net.due(1000 + 5_000), "5s, having failed");
  net.busy = true;
  ok(!net.due(1000 + 60_000), "a probe still in flight is never overtaken");
});

Deno.test("snapshot: offline is written beside the counter, and keeps the key hints",
  async () => {
    const bar = (await snapshot("100x8", "plain", "offline"))[0];
    ok(bar.includes("offline  ·  3/7  ·  by state"), `the bar reads: ${bar.trim()}`);
    ok(bar.includes("^t chat"), "and 100 cells still has room for the keys");
    ok(!(await snapshot("100x8", "plain"))[0].includes("offline"), "nothing when it is up");
  });

// the bell

Deno.test("bell: BOTTLE unpacks to the WAV the python built, byte for byte", async () => {
  await loadBell();
  const wav = soundBytes();
  eq(wav.length, 17684, "44 bytes of RIFF header and 17640 of PCM");
  const sum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", wav))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  eq(sum, "36d0609844e5a0f1c0381dc174e714344b29b4b9ee46bb85a27db52b39ccc521", "sha256");
});

Deno.test("bell: the hand-written RIFF header says mono 22050Hz 16-bit", async () => {
  await loadBell();
  const wav = soundBytes();
  const text = new TextDecoder();
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  eq(text.decode(wav.subarray(0, 4)), "RIFF", "the magic");
  eq(view.getUint32(4, true), wav.length - 8, "the RIFF size counts everything after it");
  eq(text.decode(wav.subarray(8, 16)), "WAVEfmt ", "the format chunk");
  eq(view.getUint32(16, true), 16, "fmt chunk size");
  eq(view.getUint16(20, true), 1, "PCM, uncompressed");
  eq(view.getUint16(22, true), 1, "mono");
  eq(view.getUint32(24, true), 22050, "sample rate");
  eq(view.getUint32(28, true), 22050 * 2, "byte rate");
  eq(view.getUint16(32, true), 2, "block align");
  eq(view.getUint16(34, true), 16, "bits per sample");
  eq(text.decode(wav.subarray(36, 40)), "data", "the data chunk");
  eq(view.getUint32(40, true), 17640, "8820 samples, which is 0.40s at 22050Hz");
});

Deno.test("bell: loadBell is idempotent and the bytes are stable", async () => {
  await loadBell();
  const first = soundBytes();
  await loadBell();
  ok(soundBytes() === first, "the second call must not rebuild the buffer");
});

// the two version-coupled scrapers
// a Claude Code screen and a Claude Code title, both undocumented and version-coupled:
// a rename is not caught anywhere else

const SPINNER_LINE = "✽ Working… (16m 29s · ↓ 54.6k tokens)";

Deno.test("paneState: an empty capture is not a state", () => {
  eq(paneState(""), "", "nothing was read, so the caller keeps the previous state");
  eq(paneState("\n\n   \n\t\n"), "", "blank lines are nothing too");
});

Deno.test("paneState: the spinner line is busy, with or without the timer", () => {
  eq(paneState(SPINNER_LINE), "busy", "the full spinner line");
  // ~3% of captures during a turn catch the label before the parenthetical is drawn
  eq(paneState("✽ Beboppin'…"), "busy", "no timer yet");
  for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽", "*"]) {
    eq(paneState(`${glyph} Thinking…`), "busy", `the spinner cycles through ${glyph}`);
  }
});

Deno.test("paneState: tool output that looks like the spinner is not busy", () => {
  eq(paneState("⏺ Calling chrome-devtools 5 times…"), "wait",
    "the glyph anchor is what keeps tool output out");
  eq(paneState("some answer\nesc to interrupt"), "wait",
    "`esc to interrupt` is printed by idle panes too, verified live");
  eq(paneState("✽ Working (16m 29s)"), "wait", "a spinner glyph with no ellipsis is not one");
});

Deno.test("paneState: it judges from the bottom 8 lines, not the scrollback", () => {
  const filler = (n) => Array(n).fill("a line of transcript").join("\n");
  eq(paneState(`${SPINNER_LINE}\n${filler(7)}`), "busy", "7 lines below: still in the window");
  eq(paneState(`${SPINNER_LINE}\n${filler(8)}`), "wait", "8 lines below: out of the window");
  eq(paneState(`${SPINNER_LINE}\n${filler(20)}`), "wait",
    "a pane that merely quotes the spinner 20 lines up must not read as busy");
  // blank lines are dropped before the window is taken, so they do not push it out
  eq(paneState(`${SPINNER_LINE}\n${Array(20).fill("").join("\n")}`), "busy",
    "blank lines do not count against the 8");
});

Deno.test("paneState: the banner is free until a reply is under it", () => {
  eq(paneState("Claude Code v2.1.252\n\n cwd: ~/prj/ccx"), "free", "a freshly cleared session");
  eq(paneState("Claude Code v2.1.252\n⏺ an answer\n> "), "wait",
    "walking up from the bottom hits the answer first, so this is a conversation");
  eq(paneState("Claude Code without a version"), "wait", "the banner needs its version number");
  eq(paneState("> "), "wait", "everything else is yours");
});

Deno.test("summaryOf: the glyph comes off and the literal default becomes nothing", () => {
  eq(summaryOf("✳ port ccx from python to deno"), "port ccx from python to deno", "a title");
  eq(summaryOf("Claude Code"), "", "the literal default is not a title");
  eq(summaryOf("✻ Claude Code"), "", "nor is it with the glyph in front");
  eq(summaryOf(""), "", "nothing");
  eq(summaryOf("   spaced out   "), "spaced out", "trimmed at both ends");
  eq(summaryOf("✽ 日本語のタイトル"), "日本語のタイトル", "the glyph strip is not ascii-only");
  eq(summaryOf("Claude Code review of the auth flow"),
    "Claude Code review of the auth flow", "only the exact literal is dropped");
});

// the cursor row, in full color
// the one part of the frame `plain` cannot show, the fill being a background that `plain`
// strips; `cursor=N` and `offset=N` are what make it reachable

const ESCAPE = "\x1b";          // built, not a regex literal: deno lint's no-control-regex
const SGR = new RegExp(`${ESCAPE}\\[([0-9;]*)m`, "g");

// one {bg, fg, bold} per display cell: a run is a reset, a background, optionally a
// foreground and a bold, then text, so state carries forward to the next reset
function attrs(line) {
  const cells = [];
  let bg = "", fg = "", bold = false, at = 0;
  SGR.lastIndex = 0;
  for (;;) {
    const m = SGR.exec(line);
    for (const c of line.slice(at, m ? m.index : line.length)) {
      cells.push({bg, fg, bold});
      if (width(c) === 2) cells.push({bg, fg, bold});      // the continuation cell
    }
    if (!m) return cells;
    const p = m[1];
    if (p === "0" || p === "") [bg, fg, bold] = ["", "", false];
    else if (p === "1") bold = true;
    else if (p.startsWith("48;2;")) bg = p.slice(5);
    else if (p.startsWith("38;2;")) fg = p.slice(5);
    at = SGR.lastIndex;
  }
}

const FILL = "42;30;56";        // PALETTE.cursor #2a1e38
const BLACK = "0;0;0";          // PALETTE.bg, which the margins keep
const GOLD = "255;213;0";       // STATE.wait.color and STATE.ask.color
const TEAL = "147;174;170";     // STATE.busy.color #93aeaa
const DIM = "98;98;98";         // PALETTE.dim, the number and age columns
const MAUVE = "184;160;190";    // PALETTE.mauve, the path
const TEXT = "214;214;220";     // PALETTE.text, a wait row's summary
const IDLE = "130;130;138";     // PALETTE.idle, every other summary

const filled = (frame) => frame.filter((l) => attrs(l).some((c) => c.bg === FILL));

Deno.test("cursor: exactly one row is filled, and it is the ranked index", async () => {
  const frame = await snapshot("100x8", "cursor=2", "offset=1");
  eq(filled(frame).length, 1, "one row, never two, never the bar or the header");
  eq(frame.indexOf(filled(frame)[0]), HEAD + 2 - 1,
    "ranked index 2 drawn from offset 1 is the second row on screen");
  for (const n of [0, 1, 2]) {
    ok(!attrs(frame[n]).some((c) => c.bg === FILL), `line ${n} is chrome, not a row`);
  }
});

Deno.test("cursor: the fill covers the whole table body, and the margins stay black",
  async () => {
    const cells = attrs(filled(await snapshot("100x8", "cursor=2", "offset=1"))[0]);
    eq(cells.length, 100, "one entry per cell of a 100-wide line");
    eq(cells[0].bg, BLACK, "the one-cell left margin is not part of the row");
    eq(cells[99].bg, BLACK, "nor is the right pad");
    for (let n = 1; n <= 98; n++) {
      eq(cells[n].bg, FILL, `body cell ${n} must be filled, gaps between columns included`);
      ok(cells[n].bold, `body cell ${n} is bold`);
    }
  });

Deno.test("cursor: every cell keeps its own foreground under the fill", async () => {
  const wait = attrs(filled(await snapshot("100x8", "cursor=2", "offset=1"))[0]);
  eq(wait[STATE_COL].fg, GOLD, "the selected wait row is still yellow: the rule itself");
  eq(wait[NUM].fg, DIM, "the digit");
  eq(wait[FOR].fg, DIM, "the age");
  eq(wait[PATH].fg, MAUVE, "the path");
  eq(wait[SUMMARY].fg, TEXT, "a wait row's summary is the bright one");

  // a busy row selected: different label color, different summary color, same fill
  const busy = attrs(filled(await snapshot("100x8", "cursor=3"))[0]);
  eq(busy[STATE_COL].fg, TEAL, "busy keeps its trace of teal when selected");
  eq(busy[SUMMARY].fg, IDLE, "and its summary stays the dim grey");
  eq(busy[STATE_COL].bg, FILL, "under the same fill");
});

Deno.test("cursor: an unselected row keeps the screen background", async () => {
  const frame = await snapshot("100x8", "cursor=2", "offset=1");
  const other = attrs(frame[HEAD]);            // ranked index 1, not the cursor
  for (let n = 0; n < 100; n++) {
    eq(other[n].bg, BLACK, `cell ${n} of an unselected row`);
    ok(!other[n].bold, `cell ${n} of an unselected row is not bold`);
  }
  eq(other[STATE_COL].fg, GOLD, "it is a wait row, so still gold, just not filled");
});

Deno.test("cursor: the fill is keyed on the ranked index, not the screen row", async () => {
  // scrolled past, so nothing on screen is the cursor and nothing is filled
  eq(filled(await snapshot("100x8", "cursor=0", "offset=2")).length, 0, "no row is filled");
});

Deno.test("offset: the table starts at the ranked index, and the digits follow it",
  async () => {
    const frame = await snapshot("100x8", "plain", "cursor=2", "offset=1");
    eq(at(frame[HEAD], PATH, 9), "~/prj/ccx", "ranked index 1 is drawn first");
    eq(at(frame[HEAD], NUM), "2", "the digit is the ranked position, not the screen row");
    eq(at(frame[HEAD + 1], NUM), "3", "and it keeps counting");
    // 7 ranked, 4 drawn, so 3 are not on screen: index 0 above and 5 and 6 below
    eq(at(frame[7], STATE_COL, 6), "3 more", "the count is what is not drawn, either end");
  });

Deno.test("cursor: the SGR constants above are PALETTE and STATE, not copied hexes", () => {
  const rgb = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  };
  eq(rgb(PALETTE.cursor), FILL, "the cursor fill");
  eq(rgb(PALETTE.bg), BLACK, "the screen background");
  eq(rgb(STATE.wait.color), GOLD, "wait");
  eq(rgb(STATE.ask.color), GOLD, "ask draws the other glyph in the same gold");
  eq(rgb(STATE.busy.color), TEAL, "busy");
  eq([rgb(PALETTE.dim), rgb(PALETTE.mauve)], [DIM, MAUVE], "the dim and mauve columns");
  eq([rgb(PALETTE.text), rgb(PALETTE.idle)], [TEXT, IDLE], "the two summary colors");
});

// the bell rule
// StateClock.update() shells out to nothing, so the bell rule is testable without a live
// discover(). Both UIs ring on `clock.woke.length`, one sound per pass, not per instance

const inst = (pid, state, extra = {}) =>
  new Instance({pid, state, statusSince: 0, lastWrite: 0, ...extra});

Deno.test("StateClock: first sight is not a transition, so startup is silent", () => {
  const clock = new StateClock();
  clock.update([inst(1, "wait"), inst(2, "wait"), inst(3, "busy")]);
  eq(clock.woke.length, 0, "however many sessions are already waiting");
});

Deno.test("StateClock: busy -> wait rings, and nothing else does", () => {
  const ring = (from, to) => {
    const clock = new StateClock();
    clock.update([inst(1, from)]);
    clock.update([inst(1, to)]);
    return clock.woke.map((i) => i.pid);
  };
  eq(ring("busy", "wait"), [1], "a turn ended, or a prompt came up");
  eq(ring("free", "wait"), [], "leaving the banner is you starting work, not the app");
  eq(ring("wait", "busy"), [], "you sent a turn");
  eq(ring("busy", "free"), [], "the session was cleared");
  eq(ring("wait", "wait"), [], "no change at all");
  eq(ring("free", "busy"), [], "work started in an empty session");
});

Deno.test("StateClock: two flipping in one pass is one ring", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy"), inst(2, "busy")]);
  clock.update([inst(1, "wait"), inst(2, "wait")]);
  eq(clock.woke.map((i) => i.pid), [1, 2], "both are in woke");
  // both UIs test `woke.length`, so two entries are still one sound
  ok(clock.woke.length > 0, "which the UIs read as: ring");
});

Deno.test("StateClock: woke is cleared each pass, not accumulated", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy")]);
  clock.update([inst(1, "wait")]);
  eq(clock.woke.length, 1, "the transition");
  clock.update([inst(1, "wait")]);
  eq(clock.woke.length, 0, "and the pass after it is silent");
});

Deno.test("StateClock: a state that could not be read carries the previous one forward",
  () => {
    const clock = new StateClock();
    clock.update([inst(1, "busy", {statusSince: 1000})]);
    clock.update([inst(1, "")]);          // an empty capture, or a tmux hiccup
    const [held] = clock.update([inst(1, "")]);
    eq(held.state, "busy", "an unreadable screen is not a transition");
    eq(held.since, 1000, "and it does not restart the clock");
    eq(clock.woke.length, 0, "a dropped poll must not ring for every running instance");
  });

Deno.test("StateClock: with nothing known at all, an unreadable state is wait", () => {
  const [first] = new StateClock().update([inst(1, "")]);
  eq(first.state, "wait", "the safe default: wait is what an unrecognized screen reads as");
});

Deno.test("StateClock: `since` is the record's transition, not the poll that saw it", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy", {statusSince: 1000})]);
  const [moved] = clock.update([inst(1, "wait", {statusSince: 1234})]);
  eq(moved.since, 1234, "statusUpdatedAt, which is the transition itself");
});

Deno.test("StateClock: `since` is carried while the state does not change", () => {
  const clock = new StateClock();
  clock.update([inst(1, "wait", {statusSince: 1000})]);
  // idle and shell both map to wait, so a flip between them keeps the earlier time
  const [same] = clock.update([inst(1, "wait", {statusSince: 9999})]);
  eq(same.since, 1000, "the state did not change, so neither did the clock");
});

Deno.test("StateClock: with no record, `since` seeds from the session log's mtime", () => {
  const [seeded] = new StateClock().update([inst(1, "wait", {lastWrite: 555})]);
  eq(seeded.since, 555, "logs are appended only on real messages");
  const now = Date.now() / 1000;
  const [blind] = new StateClock().update([inst(2, "wait")]);
  ok(Math.abs(blind.since - now) < 5, "and with neither, now");
});

Deno.test("StateClock: a pid that went away is first sight again when it returns", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy")]);
  clock.update([]);                       // the session exited, or one poll missed it
  clock.update([inst(1, "wait")]);
  eq(clock.woke.length, 0, "nothing remembers it was busy, so it cannot ring");
});

Deno.test("StateClock: a `since` of 0 means absent and must fall through", () => {
  // || and not ??: 0 and "" are how these fields say "absent", and ?? would take a
  // statusSince of 0 as 1970
  const [seeded] = new StateClock().update([inst(1, "wait", {statusSince: 0, lastWrite: 555})]);
  eq(seeded.since, 555, "first sight: a zero statusSince falls through to lastWrite");

  const clock = new StateClock();
  clock.update([inst(2, "busy", {statusSince: 1000})]);
  const [moved] = clock.update([inst(2, "wait", {statusSince: 0})]);
  ok(moved.since > 1e9, `a transition with no record time takes now, not 0: got ${moved.since}`);
});

// the chat view

// The frame goes through `--snapshot chat`, which draws CHAT_SAMPLE against a fixed `at`,
// since an age off the clock is not reproducible. Mirrored here the way ROWS mirrors SAMPLE.
const CHAT_HEAD = 2;            // bar, rule, then the conversation

Deno.test("chat: every line is exactly as wide as the screen", async () => {
  for (const box of ["100x22", "46x20", "60x8"]) {
    const frame = await snapshot("chat", box, "plain");
    const cols = Number(box.split("x")[0]);
    frame.forEach((line, n) => eq(width(line), cols, `line ${n} of ${box}`));
  }
});

Deno.test("chat: a header is the relative age, the sender and the recipient", async () => {
  const frame = await snapshot("chat", "100x22", "plain");
  eq(frame[CHAT_HEAD].trimEnd(), "   2h  ccx-ef → ccx-85", "age, from, to");
});

Deno.test("chat: the body wraps under its header rather than truncating", async () => {
  const frame = await snapshot("chat", "100x22", "plain");
  const body = frame.slice(CHAT_HEAD + 1, CHAT_HEAD + 4).map((l) => l.trimEnd());
  ok(body[0].startsWith("       you own ccx"), `indented past the age: ${body[0]}`);
  ok(body[2].endsWith("disk."), `the tail of a 190-character body is drawn: ${body[2]}`);
  eq(frame[CHAT_HEAD + 4].trim(), "", "one blank line before the next message");
});

Deno.test("chat: a word longer than the line is cut, and nothing is lost", async () => {
  const frame = await snapshot("chat", "46x40", "plain");
  const joined = frame.map((l) => l.trimEnd().replace(/^ {7}/, "")).join("");
  ok(joined.includes("/Users/fserb/prj/ccx/a-very-long-directory-name-that-does-not-fit-" +
    "on-one-line-at-all/deeper"), "every character of the path survives the cut");
});

Deno.test("chat: a newline in a body starts a new line", async () => {
  const frame = (await snapshot("chat", "100x22", "plain")).map((l) => l.trimEnd());
  const n = frame.findIndex((l) => l.endsWith("chat.js is in."));
  ok(n > 0, "the body stops where the newline was");
  ok(frame[n + 1].includes("the log is"), `and the rest is under it: ${frame[n + 1]}`);
});

Deno.test("chat: offset scrolls by line, and the bar stays put", async () => {
  const top = await snapshot("chat", "46x20", "plain");
  const down = await snapshot("chat", "46x20", "plain", "offset=3");
  eq(down[CHAT_HEAD], top[CHAT_HEAD + 3], "three lines of conversation went up");
  eq(down[0], top[0], "the bar does not scroll");
});

Deno.test("chat: an empty conversation says so, and counts zero", async () => {
  const frame = await snapshot("chat", "100x10", "plain", "empty");
  ok(frame[CHAT_HEAD].includes("nothing has been said in here yet"), `note: ${frame[2]}`);
  ok(frame[0].includes("0 msg"), `count: ${frame[0].trim()}`);
});

Deno.test("chat: the list's key hints name the key that opens it", async () => {
  const frame = await snapshot("100x14", "plain");
  ok(frame[0].includes("^t chat"), `the bar: ${frame[0].trim()}`);
});

// the target resolver, and the argument validation

// Both drive the script as a subprocess, for the reason the frame does. Every case here is
// decided before `ccx` looks at live state: `--resolve` runs against --snapshot's fixed
// rows, and each bad argument list below exits on its own validation ahead of discover().
// So this stays what the file header claims, and it sends no message to anybody.

async function ccx(...args) {
  const {code, stdout, stderr} = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--ext=js", CCX, ...args],
  }).output();
  const dec = new TextDecoder();
  return {code, out: dec.decode(stdout).trimEnd(), err: dec.decode(stderr).trimEnd()};
}

async function resolved(...args) {
  const {out} = await ccx("--resolve", ...args);
  return out ? out.split("\n") : [];
}

Deno.test("resolve: a pid picks that instance and nothing else", async () => {
  eq(await resolved("1002"), ["1002 blob2-7c ~/web/blob2"], "the pid is exact");
});

Deno.test("resolve: a name picks that instance and nothing else", async () => {
  eq(await resolved("kanji-90"), ["1005 kanji-90 ~/prj/kanji"], "the name is exact");
});

Deno.test("resolve: a fuzzy target matching two is the feature, not an error", async () => {
  eq(await resolved("ccx"), ["1000 ccx-e8 ~/prj/ccx", "1004 ccx-2f ~/prj/ccx:2"],
    "both ccx sessions");
});

Deno.test("resolve: the fuzzy match reaches the name as well as the path", async () => {
  eq(await resolved("wr3"), ["1001 wrangler-3a ~/prj/wrangler"],
    "wr3 is in the name and not in the path");
});

Deno.test("resolve: all is every instance, and self= leaves us out of it", async () => {
  eq((await resolved("all")).length, 7, "every row in the fixture");
  const rest = await resolved("all", "self=1002");
  eq(rest.length, 6, "one fewer");
  ok(!rest.some((l) => l.startsWith("1002 ")), `and it is not us: ${rest.join(" | ")}`);
});

Deno.test("resolve: the same instance named twice is one target", async () => {
  eq(await resolved("1005,kanji-90"), ["1005 kanji-90 ~/prj/kanji"],
    "a pid and a name for one session send it one message");
});

Deno.test("resolve: targets keep the order they were written in", async () => {
  eq(await resolved("1005,1000"),
    ["1005 kanji-90 ~/prj/kanji", "1000 ccx-e8 ~/prj/ccx"], "not re-sorted");
});

Deno.test("resolve: a target matching nothing is a miss, and the rest still resolve",
  async () => {
    eq(await resolved("nope,1000"), ["miss nope", "1000 ccx-e8 ~/prj/ccx"], "one of each");
  });

const BAD = [
  ["send"],                     // no target and nothing to say
  ["send", "ccx-e8"],           // a target and nothing to say
  ["send", "ccx-e8", "   "],    // whitespace is not a message
  ["chat", "foo"],              // chat takes --no-follow, or nothing
  ["--resolve"],                // no target
  ["--snapshot", "bogus"],
  ["focus"],                    // arity, which the command table checks
  ["nonesuch"],
];

Deno.test("validation: every bad argument list is a usage line and exit 2", async () => {
  for (const args of BAD) {
    const r = await ccx(...args);
    const what = `ccx ${args.join(" ")}`;
    eq(r.code, 2, `${what} should exit 2`);
    ok(r.err.startsWith("usage: ccx"), `${what}: stderr was ${JSON.stringify(r.err)}`);
    eq(r.out, "", `${what} should print nothing on stdout`);
  }
});

Deno.test("help: asking for it is stdout and 0, a bad argument list is stderr and 2",
  async () => {
    const asked = await ccx("help");
    eq(asked.code, 0, "`ccx help` is not an error");
    eq(asked.err, "", "and says nothing on stderr");
    ok(asked.out.startsWith("usage: ccx"), `stdout was ${JSON.stringify(asked.out)}`);
    // one text, two streams: every command the table dispatches is named in it
    for (const name of ["list", "doctor", "focus", "send", "chat", "systray", "help"]) {
      ok(new RegExp(`^  ${name}\\b`, "m").test(asked.out), `${name} is not in the help`);
    }
    eq((await ccx("nonesuch")).err, asked.out, "and a bad command prints the same text");
  });

Deno.test("validation: a bad argument list is never a traceback", async () => {
  for (const args of BAD) {
    const {err} = await ccx(...args);
    ok(!/^\s+at /m.test(err), `ccx ${args.join(" ")} leaked a stack:\n${err}`);
    ok(!/\bError\b/.test(err), `ccx ${args.join(" ")} leaked an exception:\n${err}`);
  }
});

Deno.test("validation: send with no message never reaches resolution", async () => {
  // the order matters: a target is resolved against live state, so a message that is not
  // there has to be caught first or `ccx send ccx-ef` would go looking for ccx-ef
  const {code, err, out} = await ccx("send", "ccx-e8");
  eq(code, 2, "exit 2");
  eq(out, "", "and nothing was resolved, listed or sent");
  ok(err.startsWith("usage: ccx"), `usage: ${err.split("\n")[0]}`);
});
