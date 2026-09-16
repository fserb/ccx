// Every running Claude Code instance, and how to focus one. No UI here: discover() is the
// listing, jump() is the action. See `## How the mapping works` in CLAUDE.md.

export const HOME = Deno.env.get("HOME") ?? "";
export const MAC = Deno.build.os === "darwin";

const UTF8 = new TextDecoder();
// Python compares strings by code point. localeCompare collates instead, which puts
// case and punctuation in a different order, so the `path` sort would not match.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const BYTES = new TextEncoder();

// ------------------------------------------------------------------ the listing

// No timeout. The Python passed timeout=4 to subprocess.run; Deno's outputSync has no
// equivalent, and every caller here is on the UI thread, so a tmux that never returns
// hangs the app rather than dropping one poll. Left as is because the async rewrite is
// the same change as moving discover() off the UI thread, which is its own TODO.
export function sh(...args) {
  try {
    const r = new Deno.Command(args[0], {args: args.slice(1), stdin: "null"}).outputSync();
    return r.code === 0 ? UTF8.decode(r.stdout) : "";
  } catch {
    return "";
  }
}

export class Instance {
  constructor(fields) {
    this.pid = 0;
    this.pane = "";
    this.session = "";
    this.window = "";
    this.paneIndex = "";
    this.tab = "";            // window index, only when the session holds >1 claude
    this.path = "";
    this.summary = "";
    this.state = "";          // "" until StateClock fills it in
    this.statusSince = 0;     // epoch of the record's last status change, 0 without one
    this.lastWrite = 0;       // epoch claude last wrote to its session log
    this.since = 0;           // epoch this instance entered its current state
    this.clientTty = "";
    this.kittyPid = "";       // kitty's own child above the tmux client; what `pid:` matches
    this.kittyProc = "";      // kitty itself; what a Wayland compositor knows the window by
    Object.assign(this, fields);
  }

  get match() {
    return this.kittyPid ? `pid:${this.kittyPid}` : null;
  }

  get shortPath() {
    const path = this.path ? this.path.replace(HOME, "~") : "?";
    return this.tab ? `${path}:${this.tab}` : path;
  }

  get age() {
    return this.since ? fmtAge(Date.now() / 1000 - this.since) : "?";
  }
}

export function fmtAge(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const SESSIONS = `${HOME}/.claude/sessions`;

// Where claude keeps the session logs for a cwd: the path, non-alphanumerics to -.
function projectDir(cwd) {
  return `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
}

// When claude last wrote a message for this cwd, from its session log's mtime.
//
// tmux's `window_activity` looks like the obvious source and is useless: Claude's TUI
// repaints constantly, so an idle pane still reports activity ~now. The session log is
// only appended on real messages.
function lastWrite(path) {
  let newest = 0;
  const dir = projectDir(path);
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.name.endsWith(".jsonl")) continue;
      const t = Deno.statSync(`${dir}/${e.name}`).mtime;
      if (t) newest = Math.max(newest, t.getTime() / 1000);
    }
  } catch {
    return 0;
  }
  return newest;
}

// What Claude Code calls itself, in ~/.claude/sessions/<pid>.json, mapped onto our three.
// "waiting" is a dialog holding the screen (a permission prompt, /model, an elicitation)
// and "shell" is idle with a background shell still running; both want you, like "idle".
const RECORD_STATE = {busy: "busy", waiting: "wait", idle: "wait", shell: "wait"};
const BIG_LOG = 256 * 1024;

// Claude Code's own view of every live session, keyed by pid. `status` is the state as
// the process knows it, not as the screen looks, which is the one thing a scrape cannot
// see: busy stays set while the final message streams out.
export function sessionRecords() {
  const records = {};
  let entries;
  try {
    entries = [...Deno.readDirSync(SESSIONS)];
  } catch {
    return records;
  }
  for (const e of entries) {
    const [pid, ext] = [e.name.slice(0, e.name.indexOf(".")), e.name.slice(e.name.indexOf(".") + 1)];
    if (ext !== "json" || !/^\d+$/.test(pid)) continue;
    try {
      records[Number(pid)] = JSON.parse(Deno.readTextFileSync(`${SESSIONS}/${e.name}`));
    } catch {
      continue;
    }
  }
  return records;
}

// [state, epoch it started], or ["", 0] when this pid has no record.
//
// A session with nothing in it is free, except when a dialog is up: that one is asking
// you something, empty or not, which is what an unanswered trust prompt is.
function recordState(rec) {
  const state = RECORD_STATE[rec.status] ?? "";
  if (!state) return ["", 0];
  const empty = state === "wait" && rec.status !== "waiting" &&
    !hasReply(rec.cwd ?? "", rec.sessionId ?? "");
  return [empty ? "free" : state, (rec.statusUpdatedAt ?? 0) / 1000];
}

// Whether this session ever got an answer, which is what free is not.
//
// /clear starts a *new* sessionId, and a fresh one's log holds a handful of bookkeeping
// lines (~2.6KB) with no assistant entry, so this reads the same as a session that has
// never been asked anything. Any log past BIG_LOG is a real conversation, which keeps the
// read small; the log for a session that has said nothing yet does not exist.
function hasReply(cwd, sessionId) {
  const path = `${projectDir(cwd)}/${sessionId}.jsonl`;
  try {
    if (Deno.statSync(path).size > BIG_LOG) return true;
    return Deno.readTextFileSync(path).includes('"type":"assistant"');
  } catch {
    return false;
  }
}

// The last title line was never further than 34KB from the end of the log, over the 108
// logs on this machine that carry one, so a tail this size finds it with room to spare.
const TITLE_TAIL = 256 * 1024;
const TITLES = new Map();          // session log -> [size when read, title found]

// Claude's own name for the session, from the transcript. Cached against the log's size
// and re-read whenever it has grown, which is what carries a /rename onto the next poll.
function sessionTitle(cwd, sessionId) {
  if (!cwd || !sessionId) return "";
  const path = `${projectDir(cwd)}/${sessionId}.jsonl`;
  let size;
  try {
    size = Deno.statSync(path).size;
  } catch {
    return "";
  }
  const [sizeRead, cached] = TITLES.get(path) ?? [-1, ""];
  if (size === sizeRead) return cached;
  const title = readTitle(path, size);
  TITLES.set(path, [size, title]);
  return title;
}

// The last title in the tail of a session log, /rename's winning over the AI one.
function readTitle(path, size) {
  let text;
  try {
    const f = Deno.openSync(path, {read: true});
    try {
      const start = Math.max(0, size - TITLE_TAIL);
      f.seekSync(start, Deno.SeekMode.Start);
      const buf = new Uint8Array(size - start);
      let read = 0;
      while (read < buf.length) {
        const n = f.readSync(buf.subarray(read));
        if (n === null || n === 0) break;
        read += n;
      }
      text = UTF8.decode(buf.subarray(0, read));
    } finally {
      f.close();
    }
  } catch {
    return "";
  }
  const found = {};
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"ai-title"') && !line.includes('"type":"custom-title"')) continue;
    try {                               // the first line of the tail is a fragment
      const rec = JSON.parse(line);
      found[rec.type] = rec.customTitle ?? rec.aiTitle ?? "";
    } catch {
      continue;
    }
  }
  return found["custom-title"] ?? found["ai-title"] ?? "";
}

// When each instance entered its current state, and which ones just changed.
//
// The record's statusUpdatedAt is the transition itself, so it beats both the poll it was
// noticed in and the session-log mtime, which is only the seed left for instances with no
// record. A displayed state that spans two of Claude's own (idle and shell are both wait)
// keeps the earlier time, since the row did not change.
export class StateClock {
  constructor() {
    this.seen = new Map();
    this.woke = [];       // instances that went busy -> wait during the last update
  }

  update(instances) {
    const now = Date.now() / 1000;
    this.woke = [];
    for (const i of instances) {
      const prev = this.seen.get(i.pid);
      // a screen we could not read is not a transition: an empty capture-pane, or a tmux
      // hiccup that drops every pane, would otherwise read as wait and ring for every
      // running instance at once
      // 0 and "" are how the fields above say "absent", so these are || and not ??:
      // ?? only falls back on null, and would take a statusSince of 0 as a real time
      i.state = i.state || (prev ? prev[0] : "wait");
      if (!prev) {                                  // first sight
        i.since = i.statusSince || i.lastWrite || now;
      } else if (prev[0] === i.state) {
        i.since = prev[1];
      } else {
        i.since = i.statusSince || now;
      }
      // only busy -> wait rings, which is a turn ending or a prompt appearing. first sight
      // is not a transition, so starting up is silent however many are waiting
      if (prev && prev[0] === "busy" && i.state === "wait") this.woke.push(i);
      this.seen.set(i.pid, [i.state, i.since]);
    }
    const live = new Set(instances.map((i) => i.pid));
    for (const pid of [...this.seen.keys()]) if (!live.has(pid)) this.seen.delete(pid);
    return instances;
  }
}

const IS_CLAUDE = /(^|\/)claude(\s|$)|\.claude\/local\/.*cli\.js/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

function processes() {
  const table = new Map();
  for (const line of sh("ps", "-axo", "pid=,ppid=,command=").split("\n")) {
    const m = PS_LINE.exec(line);
    if (m) table.set(Number(m[1]), [Number(m[2]), m[3]]);
  }
  return table;
}

// [the ancestor `match pid:` will find, kitty's own pid]. kitty matches a window only by
// its DIRECT child, and ktmux keeps a wrapper zsh in between, so walk up rather than
// assuming either shape. No kitty ancestor comes back unchanged and with 0.
function kittyOwner(pid, procs) {
  let cur = pid;
  for (let n = 0; n < 12; n++) {
    const entry = procs.get(cur);
    if (!entry) break;
    const ppid = entry[0];
    const parent = procs.get(ppid);
    if (!parent) break;
    const argv0 = parent[1].split(" ")[0];
    if (argv0.slice(argv0.lastIndexOf("/") + 1) === "kitty") return [cur, ppid];
    cur = ppid;
  }
  return [pid, 0];
}

function tmuxRows(subcommand, fields, ...extra) {
  const fmt = fields.map((f) => `#{${f}}`).join("\t");
  const out = sh("tmux", subcommand, ...extra, "-F", fmt);
  return out.split("\n").filter((l) => l).map((line) => {
    const parts = line.split("\t");
    return Object.fromEntries(fields.map((f, n) => [f, parts[n] ?? ""]));
  });
}

function capture(pane, lines = 40) {
  return sh("tmux", "capture-pane", "-p", "-t", pane, "-S", `-${lines}`);
}

// The spinner line, "✽ Working… (16m 29s · ↓ 54.6k tokens)". The parenthetical is drawn a
// moment after the label, so ~3% of captures during a turn (measured) catch a bare
// "✽ Beboppin'…" and requiring it read those frames as wait. Anchor on the cycling glyph
// instead, which also keeps "⏺ Calling chrome-devtools 5 times…" (tool output, not the
// spinner) out.
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S.*…/;
const BANNER = /Claude Code v\d/;      // the startup banner, which /clear repaints

// busy (a turn is running), free (nothing in the session), or wait (yours). Judge from
// the BOTTOM of the screen: a marker matched anywhere in the scrollback misreads a pane
// that merely discusses it, which is how the pane writing this reported the wrong state.
function paneState(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return "";        // nothing was read; the caller keeps the previous state
  if (lines.slice(-8).some((l) => SPINNER.test(l))) return "busy";
  for (let n = lines.length - 1; n >= 0; n--) {
    if (lines[n].includes("⏺")) break;
    if (BANNER.test(lines[n])) return "free";
  }
  return "wait";
}

// The session title as pane_title has it, for instances with no record to read.
//
// "Claude Code" is the literal default the title falls back to before a session has a
// title of its own, not a title. The leading glyph is Claude's, and under tmux it is
// always the same one: it detects the multiplexer and stops animating it.
function summaryOf(title) {
  const text = title.replace(/^[✳✶✻✽* ·]+/, "").trim();
  return text === "Claude Code" ? "" : text;
}

export function discover() {
  const procs = processes();
  const records = sessionRecords();
  const panes = tmuxRows("list-panes", ["session_name", "window_index", "pane_index",
    "pane_id", "pane_pid", "pane_current_path", "pane_title"], "-a");
  const clients = tmuxRows("list-clients", ["client_tty", "client_pid", "client_session"]);
  const paneByPid = new Map(panes.map((p) => [Number(p.pane_pid), p]));
  const clientBySession = new Map(clients.map((c) => [c.client_session, c]));

  const found = [];
  for (const [pid, [, cmd]] of procs) {
    if (!IS_CLAUDE.test(cmd)) continue;
    const rec = records[pid] ?? {};
    const [state, since] = recordState(rec);
    let pane = null, cur = pid;
    for (let n = 0; n < 12; n++) {                 // walk up to the owning pane
      if (paneByPid.has(cur)) {
        pane = paneByPid.get(cur);
        break;
      }
      if (!procs.has(cur)) break;
      cur = procs.get(cur)[0];
    }
    const title = sessionTitle(rec.cwd ?? "", rec.sessionId ?? "");
    if (!pane) {
      // nothing to focus without a pane, but the record still knows the rest
      found.push(new Instance({pid, summary: title || cmd, path: rec.cwd ?? "",
        state, statusSince: since}));
      continue;
    }
    const client = clientBySession.get(pane.session_name) ?? {};
    const cpid = client.client_pid ?? "";
    const [child, kitty] = cpid ? kittyOwner(Number(cpid), procs) : [0, 0];
    found.push(new Instance({
      pid,
      pane: pane.pane_id,
      session: pane.session_name,
      window: pane.window_index,
      paneIndex: pane.pane_index,
      path: pane.pane_current_path,
      // the transcript is the whole answer once there is a record: it names the session
      // claude is in *now*, where pane_title still shows the one before a /clear.
      // pane_title is what is left when there is no record, as with state
      summary: Object.keys(rec).length ? title : summaryOf(pane.pane_title),
      state: state || paneState(capture(pane.pane_id)),
      statusSince: since,
      lastWrite: state ? 0 : lastWrite(pane.pane_current_path),
      clientTty: client.client_tty ?? "",
      kittyPid: cpid ? String(child) : "",
      kittyProc: kitty ? String(kitty) : "",
    }));
  }
  tagTabs(found);
  return found.sort((a, b) => byCodePoint(a.shortPath, b.shortPath) || a.pid - b.pid);
}

// Tab suffix for the path, but only where it disambiguates.
//
// One kitty window shows one tmux window at a time, so the tab number only matters when a
// session holds more than one claude. Two in the same window get `:N.M` with the pane.
function tagTabs(found) {
  for (const i of found) {
    const peers = found.filter((p) => p.session && p.session === i.session);
    if (peers.length < 2) continue;
    const sameWindow = peers.filter((p) => p.window === i.window);
    i.tab = sameWindow.length > 1 ? `${i.window}.${i.paneIndex}` : i.window;
  }
}

// The sort a UI offers, and what "state" means as an order: the ones that want you first,
// then the ones working, then the empty ones, which are interchangeable.
const STATE_ORDER = {wait: 0, busy: 1, free: 2};
export const SORTS = ["state", "path"];

// Subsequence match. Returns {score, idx} or null; lowest score wins.
//
// Greedy forward to prove the match exists, then greedy backward from the last hit, which
// pulls the matched characters as far right as they will go and so collapses "cx" onto the
// trailing `cx` of ~/prj/ccx instead of taking the c before it. Every character skipped
// costs 2, or 1 when the match lands on a word start, so a match at the head of a path
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

// The list in display order, which both UIs want identically.
//
// Within a state the one stuck there longest goes on top, so the sessions that want you
// float up. A filter outranks the sort entirely: you typed those keys to reach one row, so
// the closest match goes first and enter takes it, with the sort breaking ties.
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

// ------------------------------------------------------------------ what both UIs paint

// The TUI and the panel have to agree on these or the two tools stop looking like one
// tool, and there is no drawing layer left to share now that the panel is HTML. gold is
// the brightest thing on either screen and nothing else is allowed above it by relative
// luminance, which is what makes a `wait` row findable without reading it: gold .69, the
// wait summary .68, busy .39, every other summary .23, free and the number and age
// columns .12. #ffd500 is one shade deeper than xterm 220, the exact color Claude Code
// paints "⏵⏵ auto mode on" with, and reads as the same yellow.
export const STATE = {
  wait: {label: "● wait", color: "#ffd500"},
  busy: {label: "◐ busy", color: "#93aeaa"},
  free: {label: "◌ free", color: "#626262"},
};

// Out of ~/.config/kitty/kitty.conf, so the tools look like the terminal they run in:
// #ceaadf is color13, #b8a0be is color5.
//
// `bar` and `panelBg` are two different surfaces and the one shade between them is not a
// mistake: the TUI's top bar is Textual's `$panel`, #181020, sitting on a #000 screen,
// while the systray panel is its own floating near-black #0e0b12 over the desktop. The
// Textual theme also had #0e0b12 as `surface`, which nothing in the TUI ever drew.
export const PALETTE = {
  accent: "#ceaadf", mauve: "#b8a0be", dim: "#626262", text: "#d6d6dc",
  bg: "#000000", bar: "#181020", panelBg: "#0e0b12", edge: "#35284a", cursor: "#2a1e38",
  gold: "#ffd500", idle: "#82828a", hint: "#4a4a55", error: "#df6565",
};

// the digits label the first ten rows, in the order they are drawn
export const NUMBERS = "1234567890";

// ----------------------------------------------------------------------- the bell

// A UI rings this on StateClock.woke; the library itself never makes a sound.
//
// The sound is BOTTLE, at the bottom of this file, so the bell is the same one on both
// platforms: freedesktop's complete.oga, the old Linux default, ships with a sound theme
// and not with a base install. Nothing here writes a file. macOS plays the bytes through
// AVAudioPlayer (see ring()), Linux pipes them to a player's stdin, and each argv ends in
// how that player spells stdin: `paplay -` opens a file named `-` and fails, so paplay
// gets nothing. In order of how little they do; ffplay decodes it itself.
const PLAYERS = MAC ? [] : [
  ["pw-play", "-"],
  ["paplay"],
  ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-"],
];
let PLAYER = null;             // resolved on the first ring, then reused
let BELL = null;               // BOTTLE unpacked, by loadBell()
let RINGER = null;             // the AVAudioPlayer holding it, on the first ring; macOS only
let OBJC = null;               // the libobjc handle and its selectors, once loaded

// The player argv, resolved once: the first of PLAYERS that is installed, or [].
function bellCmd() {
  if (PLAYER === null) {
    PLAYER = PLAYERS.find((p) => sh("sh", "-c", `command -v ${p[0]}`).trim()) ?? [];
  }
  return PLAYER;
}

// What will make the sound, for doctor.
export function ringer() {
  return MAC ? "AVAudioPlayer" : bellCmd().join(" ") || "(no player)";
}

// BOTTLE unpacked into the bytes of a WAV file.
//
// Async because this is where the Python's lzma went: Deno has no lzma at all, and the
// only decompressor in the runtime is DecompressionStream, which is a stream. gzip costs
// 3517 bytes against lzma's 3128, so the source file carries 520 more characters of
// base64 and nothing else changes. Being async is why it is called once at startup
// instead of lazily on the first ring: play() is called from a poll that cannot await.
export async function loadBell() {
  if (BELL) return;
  const packed = Uint8Array.from(atob(BOTTLE.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  const plain = new Uint8Array(await new Response(
    new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  // second differences: cumulative sum twice gets the samples back. A 185Hz tone barely
  // moves between samples, which is what makes them small numbers that repeat and takes
  // 17640 bytes of PCM to 3128
  const deltas = new Int16Array(plain.buffer, plain.byteOffset, plain.length / 2);
  const pcm = new Int16Array(deltas.length);
  let run = 0, value = 0;
  for (let n = 0; n < deltas.length; n++) {
    run += deltas[n];
    value += run;
    pcm[n] = value;
  }
  BELL = wav(pcm);
}

// The 44 bytes of RIFF header in front of the samples. The Python got this from `wave`.
function wav(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(44 + bytes.length);
  const v = new DataView(out.buffer);
  out.set(BYTES.encode("RIFF"), 0);
  v.setUint32(4, 36 + bytes.length, true);
  out.set(BYTES.encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);            // fmt chunk size
  v.setUint16(20, 1, true);             // PCM
  v.setUint16(22, 1, true);             // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);      // byte rate
  v.setUint16(32, 2, true);             // block align
  v.setUint16(34, 16, true);            // bits
  out.set(BYTES.encode("data"), 36);
  v.setUint32(40, bytes.length, true);
  out.set(bytes, 44);
  return out;
}

export function soundBytes() {
  return BELL ?? new Uint8Array(0);
}

const cstr = (s) => BYTES.encode(`${s}\0`);

// Play wav through AVAudioPlayer, which takes bytes and wants no file: no macOS player
// reads stdin. THE STOP IS NOT OPTIONAL. Once the sound has run out, play on its own
// returns YES and does nothing. objc_msgSend needs one alias per signature.
function ring(sound) {
  if (!OBJC) {
    const lib = Deno.dlopen("/usr/lib/libobjc.A.dylib", {
      objc_getClass: {parameters: ["buffer"], result: "pointer"},
      sel_registerName: {parameters: ["buffer"], result: "pointer"},
      msg: {name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer"},
      msgBool: {name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "bool"},
      msgBytes: {name: "objc_msgSend",
        parameters: ["pointer", "pointer", "buffer", "usize"], result: "pointer"},
      msgTwo: {name: "objc_msgSend",
        parameters: ["pointer", "pointer", "pointer", "pointer"], result: "pointer"},
      msgDouble: {name: "objc_msgSend",
        parameters: ["pointer", "pointer", "f64"], result: "void"},
    });
    Deno.dlopen("/System/Library/Frameworks/AVFoundation.framework/AVFoundation", {});
    OBJC = lib.symbols;
  }
  const s = OBJC;
  const cls = (n) => s.objc_getClass(cstr(n));
  const sel = (n) => s.sel_registerName(cstr(n));
  if (!RINGER) {
    const data = s.msgBytes(s.msg(cls("NSData"), sel("alloc")),
      sel("initWithBytes:length:"), sound, BigInt(sound.length));
    RINGER = s.msgTwo(s.msg(cls("AVAudioPlayer"), sel("alloc")),
      sel("initWithData:error:"), data, null);
    if (!RINGER) return;
    s.msgBool(RINGER, sel("prepareToPlay"));
  }
  s.msgBool(RINGER, sel("stop"));
  s.msgDouble(RINGER, sel("setCurrentTime:"), 0);
  s.msgBool(RINGER, sel("play"));
}

// Ring the bell and return immediately. A no-op until loadBell() has run.
//
// The WAV is 17684 bytes, under the 64KB a pipe holds, so the write cannot block on a
// player that is slow to start. On Linux the player runs for the length of the sound while
// the poll comes round every 1.5s, so it is never waited on; Deno reaps the child itself
// once its status is taken, which is what the .status.catch() is for and what the Python
// needed an explicit poll() sweep to do. No player installed is no sound.
export function play() {
  if (!BELL) return;
  if (MAC) {
    try {
      ring(BELL);
    } catch {
      // no audio device, or a runtime that moved: silence beats a traceback on the TUI
    }
    return;
  }
  const cmd = bellCmd();
  if (!cmd.length) return;
  try {
    const child = new Deno.Command(cmd[0], {args: cmd.slice(1), stdin: "piped",
      stdout: "null", stderr: "null"}).spawn();
    const w = child.stdin.getWriter();
    w.write(BELL).then(() => w.close()).catch(() => {});
    child.status.catch(() => {});
  } catch {
    // nothing to play it with
  }
}

// ------------------------------------------------------------------------ the jump

// `kitten @` writes a bare `ESC P @kitty-cmd {...} ESC \` to the tty. tmux forwards only
// `ESC P tmux; ... ESC \`, so the bare form is swallowed and the command never reaches
// kitty (silently, with --no-response). So build the sequence here and wrap it.
const KITTY_RC_VERSION = [0, 26, 0];

// Send one kitty remote-control command. With a `tty` the bare sequence goes straight
// there, which is the only path that works with no controlling terminal of our own.
// Without one it falls back to /dev/tty, wrapped for tmux, which swallows a bare DCS.
export function sendKitty(command, payload, tty = null) {
  const msg = {cmd: command, version: KITTY_RC_VERSION, no_response: true, payload};
  const wid = Deno.env.get("KITTY_WINDOW_ID");
  if (wid) msg.kitty_window_id = Number(wid);
  let seq = `\x1bP@kitty-cmd${JSON.stringify(msg)}\x1b\\`;
  if (!tty && Deno.env.get("TMUX")) {
    seq = `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  }
  const target = tty ?? "/dev/tty";
  try {
    // create/truncate because that is what the Python's open(target, "w") did; on a tty,
    // which is what every real target is, both flags are no-ops
    const f = Deno.openSync(target, {write: true, create: true, truncate: true});
    try {
      f.writeSync(BYTES.encode(seq));
    } finally {
      f.close();
    }
    return true;
  } catch (e) {
    console.error(`cannot write to ${target}: ${e.message}`);
    return false;
  }
}

// The niri window id for a process, or null. niri is the compositor on the Linux box.
//
// A kitty process there owns exactly one OS window, so its pid identifies the window;
// `single_instance` or `kitty @ launch --type=os-window` would break that and this would
// raise whichever of them niri lists first. Nothing else on Wayland can do better without
// kitty telling us which of its windows is where, which it cannot.
function niriWindow(pid) {
  try {
    for (const w of JSON.parse(sh("niri", "msg", "--json", "windows") || "[]")) {
      if (String(w.pid) === String(pid)) return w.id;
    }
  } catch {
    return null;
  }
  return null;
}

// Bring the terminal's own window to the front. The per-platform half of the jump: on
// Wayland an app cannot raise itself without a recent interaction, so the compositor
// has to be asked by its own window id.
function raiseWindow(inst) {
  if (MAC) {
    sh("open", "-a", "kitty");
    return;
  }
  if (!inst.kittyProc) return;
  const wid = niriWindow(inst.kittyProc);
  if (wid !== null) sh("niri", "msg", "action", "focus-window", "--id", String(wid));
}

// What raiseWindow() would do with this instance, for `ccx doctor` to print.
export function raiseTarget(inst) {
  if (MAC) return "open -a kitty";
  if (!inst.kittyProc) return "(no kitty ancestor)";
  const wid = niriWindow(inst.kittyProc);
  return wid !== null ? `niri ${wid}` : `(kitty ${inst.kittyProc} not in niri)`;
}

// Focus the instance. Returns an error message, or null when it worked.
export function jump(inst) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to focus`;
  if (inst.clientTty) {
    sh("tmux", "switch-client", "-c", inst.clientTty, "-t", inst.session);
  } else if (Deno.env.get("TMUX")) {
    sh("tmux", "switch-client", "-t", inst.session);
  }
  sh("tmux", "select-window", "-t", `${inst.session}:${inst.window}`);
  sh("tmux", "select-pane", "-t", inst.pane);
  if (inst.match) {
    // the client's own tty, so this works with no controlling terminal of our own
    sendKitty("focus-window", {match: inst.match}, inst.clientTty || null);
  }
  raiseWindow(inst);
  return null;
}

// Quitting the TUI skips the normal unwind, so anything that has to run before the process
// dies registers itself here.
export const ON_EXIT = [];

// Name our own tmux window for as long as the app runs. Returns the restore.
//
// tmux's automatic-rename uses the pane's foreground command, which is how the tab read
// `uv` under the Python's shebang and reads `deno` under this one. `allow-rename` is off
// by default, so the ESC k escape is ignored and only `rename-window` works; it also turns
// automatic-rename off for the window, hence the restore.
export function tmuxWindowName(name) {
  const pane = Deno.env.get("TMUX_PANE");
  if (!pane) return () => {};
  const was = sh("tmux", "display-message", "-p", "-t", pane,
    "#{automatic-rename}\t#{window_name}").trim();
  sh("tmux", "rename-window", "-t", pane, name);

  const restore = () => {
    const [auto, before] = [was.slice(0, was.indexOf("\t")), was.slice(was.indexOf("\t") + 1)];
    if (auto === "1" || !before) {
      sh("tmux", "set-window-option", "-t", pane, "automatic-rename", "on");
    } else {
      sh("tmux", "rename-window", "-t", pane, before);
    }
  };
  ON_EXIT.push(restore);
  return () => {
    ON_EXIT.splice(ON_EXIT.indexOf(restore), 1);
    restore();
  };
}

// Name our own kitty window for as long as the app runs. Target the client's kitty
// ancestor, never KITTY_WINDOW_ID: inside a pane that is inherited from the environment
// the tmux SERVER started in and can name a window that closed long ago.
export function kittyWindowTitle(name) {
  let target = {};
  if (Deno.env.get("TMUX")) {
    const pid = sh("tmux", "display-message", "-p", "#{client_pid}").trim();
    if (!pid) return () => {};        // no client attached, so no window to name
    target = {match: `pid:${kittyOwner(Number(pid), processes())[0]}`};
  }
  sendKitty("set-window-title", {...target, title: name});

  const restore = () => sendKitty("set-window-title", target);  // no title: kitty's default
  ON_EXIT.push(restore);
  return () => {
    ON_EXIT.splice(ON_EXIT.indexOf(restore), 1);
    restore();
  };
}

// ------------------------------------------------------------------ the bell, inlined

// macOS's /System/Library/Sounds/Bottle.aiff, cut to fit in a source file. To redo it:
//
//     afconvert -f WAVE -d LEI16@22050 -c 2 Bottle.aiff b.wav    # a real resampler
//     x = (left + right) / 2, cut to 0.40s, 40ms fade, round(x / 16) * 16
//     base64(gzip(second differences of x, as little-endian int16))
const RATE = 22050;
const BOTTLE = `
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
lPRbvnZwm5P7+nF13kNOrQpMjGcf2WLyOUdVtFTiHBS3eRSxis9AaleeSkCRvaoiSnLbbGG5Mspmzaq0OkMjztf4ukSepO9h
ypay1moUkOcjWCFSJVIFcI4F5tVBWjae4FVlNFfVGQyJxp6hb9IG8BTF5zrjWi4xR9mn3AduIa7lXlg9Q8m7nE19BgNFLtHS
Qet8R/s3z49KybRRR6jyKXiDR3JktHUWKEaXWo85B5XRUhdI6lmOVef87TM05dqGjR2flmeVls5X5XPd17R1qM441+Wvlj5b
59hK78STkzitk0Bce8gyd8UiZl29yByf10NcQmcy/PzkUPb90hbhZF7tM1e159T8tTktY02WRivWtiijiPVl7/OTZNk/9ypb
KFeZ0o7fnfzn6yBWOxh4smcrq+XSVmvraa8DrSgt97ta861niyd+WUugvN8+K9c64dbWa7mrWleY2JBlO47ip/+h0bb7ch+2
tYuKUOd62Izd70/1tWNEK460ziuW3n1u+VKadfSDt9+ldba8URc+qE2549rKm84jJZ6eGPncB1unFrCxV13v1UHTZlFE6a96
ADTP6WLD18+trmU/73dC2/Jsxdr6JPpZXDnj7ytza6+tn+vxM722vLglhXPPPD+HAnB+puazVbaO5/gl/bY1cDaDVmzF31gz
2rb8WfT/XBbf0/O7WZ3N5f3cWmujbmQL39fse11+Jfs4O5l9loN81vJsjPf2/HkW/rV1/6t++9UZfyWz+errTNPw5pQKfGOW
EbuBb2q7fvpTM34vgXfy+D3qiiEq+Jbnz2d8PuczPv+M/9/pXc9CF/9t8ftj1MjVn9H8GQv6Lp3ve9E/NYvf7fmnXvE3XjwX
RbZj/d4av2Z/Pxtz/o6M3+v6q0/fcfU+J//p1xnHP+XT3+X+J+b4tzz5/8F//339+/ra6782DRAM6EQAAA==`;
