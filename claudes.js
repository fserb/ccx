// Every running Claude Code instance and what it is doing. No UI here, and no focusing
// either: discover() is the listing, jump() in jump.js is the action.

import {byCodePoint, HOME, sh, UTF8} from "./sh.js";

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
    this.asking = "";         // the record's waitingFor: a dialog is up, and which one
    this.name = "";           // the session's own name, what a peer addresses it by
    this.sock = "";           // the record's messagingSocketPath, where peer.js delivers
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
export function slug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function projectDir(cwd) {
  return `${HOME}/.claude/projects/${slug(cwd)}`;
}

// When claude last wrote for this cwd, by its session log's mtime. tmux's
// `window_activity` is useless: the TUI repaints constantly, so an idle pane reports ~now.
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

// Claude Code's own `status`, in ~/.claude/sessions/<pid>.json, onto our three. "waiting"
// is a dialog holding the screen, "shell" is idle with a background shell still running;
// both want you, like "idle".
const RECORD_STATE = {busy: "busy", waiting: "wait", idle: "wait", shell: "wait"};
const BIG_LOG = 256 * 1024;

// Every live session as Claude Code knows it, keyed by pid. The state as the process has
// it, not as the screen looks: busy stays set while the final message streams out.
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

// [state, epoch it started], or ["", 0] with no record. An empty session is free unless a
// dialog is up: an unanswered trust prompt wants you, empty or not.
function recordState(rec) {
  const state = RECORD_STATE[rec.status] ?? "";
  if (!state) return ["", 0];
  const empty = state === "wait" && rec.status !== "waiting" &&
    !hasReply(rec.cwd ?? "", rec.sessionId ?? "");
  return [empty ? "free" : state, (rec.statusUpdatedAt ?? 0) / 1000];
}

// Whether this session ever got an answer, which is what free is not. /clear starts a
// *new* sessionId whose log is ~2.6KB of bookkeeping with no assistant entry, reading the
// same as one never asked anything. Past BIG_LOG it is a real conversation, unread.
// Cached once true, since a log is only appended to, or every poll re-reads up to BIG_LOG
// of each waiting session.
const REPLIED = new Set();

function hasReply(cwd, sessionId) {
  const path = `${projectDir(cwd)}/${sessionId}.jsonl`;
  if (REPLIED.has(path)) return true;
  try {
    if (Deno.statSync(path).size <= BIG_LOG &&
      !Deno.readTextFileSync(path).includes('"type":"assistant"')) return false;
  } catch {
    return false;
  }
  REPLIED.add(path);
  return true;
}

const TITLE_TAIL = 256 * 1024;     // titles sit at most 34KB from the end, over 108 logs
const TITLES = new Map();          // session log -> [size when read, title found]

// Claude's own name for the session, cached against the log's size and re-read when it
// has grown, which is what carries a /rename onto the next poll.
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
// statusUpdatedAt is the transition itself, so it beats the poll that noticed it and the
// log mtime, which only seeds instances with no record. idle and shell are both wait, so a
// flip between them keeps the earlier time.
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
      // a screen we could not read is not a transition: an empty capture would otherwise
      // read as wait and ring every instance at once. || not ??, since 0 and "" mean absent
      i.state = i.state || (prev ? prev[0] : "wait");
      if (!prev) {                                  // first sight
        i.since = i.statusSince || i.lastWrite || now;
      } else if (prev[0] === i.state) {
        i.since = prev[1];
      } else {
        i.since = i.statusSince || now;
      }
      // only busy -> wait rings; first sight is not a transition, so startup is silent
      if (prev && prev[0] === "busy" && i.state === "wait") this.woke.push(i);
      this.seen.set(i.pid, [i.state, i.since]);
    }
    const live = new Set(instances.map((i) => i.pid));
    for (const pid of [...this.seen.keys()]) if (!live.has(pid)) this.seen.delete(pid);
    return instances;
  }
}

// argv0 is claude, or argv1 is the local install's cli.js. Anywhere in the line was too
// loose: `less ~/notes/claude` matched and drew a row.
export const IS_CLAUDE = /^(\S*\/)?claude(\s|$)|^\S+\s+\S*\.claude\/local\/\S*cli\.js(\s|$)/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

export async function processes() {
  const table = new Map();
  for (const line of (await sh("ps", "-axo", "pid=,ppid=,command=")).split("\n")) {
    const m = PS_LINE.exec(line);
    if (m) table.set(Number(m[1]), [Number(m[2]), m[3]]);
  }
  return table;
}

// [the ancestor `match pid:` will find, kitty's own pid]. kitty matches a window only by
// its DIRECT child and ktmux keeps a wrapper zsh in between, so walk up rather than assume
// either shape. No kitty ancestor comes back unchanged and with 0.
export function kittyOwner(pid, procs) {
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

// Several `-F` listings out of ONE tmux invocation: tmux takes `;`-separated commands in
// one call (3.8ms against 8.6ms apart), the output interleaves so each spec's rows carry
// their own key, and they share one exit status. `sh()` returns "" on failure, so a lost
// listing is an empty table and not a throw.
async function tmuxTables(specs) {
  const argv = [];
  for (const [key, subcommand, fields, ...extra] of specs) {
    if (argv.length) argv.push(";");
    const fmt = fields.map((f) => `#{${f}}`).join("\t");
    argv.push(subcommand, ...extra, "-F", `${key}\t${fmt}`);
  }
  const out = await sh("tmux", ...argv);
  const tables = Object.fromEntries(specs.map(([key]) => [key, []]));
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const spec = specs.find(([key]) => key === parts[0]);
    if (!spec) continue;
    tables[parts[0]].push(
      Object.fromEntries(spec[2].map((f, n) => [f, parts[n + 1] ?? ""])));
  }
  return tables;
}

function capture(pane, lines = 40) {
  return sh("tmux", "capture-pane", "-p", "-t", pane, "-S", `-${lines}`);
}

// The spinner, "✽ Working… (16m 29s · ↓ 54.6k tokens)". The parenthetical is drawn a
// moment after the label, so ~3% of mid-turn captures lack it and requiring it read those
// frames as wait. The glyph anchor also keeps "⏺ Calling chrome-devtools 5 times…" out,
// which is tool output and not the spinner.
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S.*…/;
const BANNER = /Claude Code v\d/;      // the startup banner, which /clear repaints

// busy, free or wait, judged from the BOTTOM of the screen only: a marker matched
// anywhere in the scrollback misreads a pane that merely displays it.
export function paneState(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return "";        // nothing was read; the caller keeps the previous state
  if (lines.slice(-8).some((l) => SPINNER.test(l))) return "busy";
  for (let n = lines.length - 1; n >= 0; n--) {
    if (lines[n].includes("⏺")) break;
    if (BANNER.test(lines[n])) return "free";
  }
  return "wait";
}

// The session title as pane_title has it, for instances with no record to read. "Claude
// Code" is the literal default before a session has a title of its own, and the leading
// glyph is Claude's, always the same one under tmux, which it detects and stops animating.
export function summaryOf(title) {
  const text = title.replace(/^[✳✶✻✽* ·]+/, "").trim();
  return text === "Claude Code" ? "" : text;
}

// Every running claude, with where it is and what it is doing. Async because it shares a
// task with the input loop: `ps` and the tmux listing overlap instead of adding up, and so
// do the record-less screen scrapes.
export async function discover() {
  const [procs, tmux] = await Promise.all([
    processes(),
    tmuxTables([
      ["p", "list-panes", ["session_name", "window_index", "pane_index",
        "pane_id", "pane_pid", "pane_current_path", "pane_title"], "-a"],
      ["c", "list-clients", ["client_tty", "client_pid", "client_session"]],
    ]),
  ]);
  const records = sessionRecords();
  const [panes, clients] = [tmux.p, tmux.c];
  const paneByPid = new Map(panes.map((p) => [Number(p.pane_pid), p]));
  const clientBySession = new Map(clients.map((c) => [c.client_session, c]));

  const found = [];
  const scrape = [];              // [instance, pane_id] for the ones with no record
  for (const [pid, [, cmd]] of procs) {
    if (!IS_CLAUDE.test(cmd)) continue;
    const rec = records[pid] ?? {};
    // `claude -p` walks up to whatever pane launched it, so it is a phantom second row.
    // `kind` does NOT separate them: on 2.1.273 both say `interactive`, and `entrypoint`
    // is `cli` for a TUI against `sdk-cli` for -p. "not cli" so an entrypoint nobody has
    // seen is left out rather than let in; a record-less instance still passes, to scrape
    if (rec.entrypoint && rec.entrypoint !== "cli") continue;
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
    if (!pane) {                                   // nothing to focus, but the record knows
      found.push(new Instance({pid, summary: title || cmd, path: rec.cwd ?? "",
        state, asking: rec.status === "waiting" ? (rec.waitingFor ?? "") : "",
        name: rec.name ?? "", sock: rec.messagingSocketPath ?? "", statusSince: since}));
      continue;
    }
    const client = clientBySession.get(pane.session_name) ?? {};
    const cpid = client.client_pid ?? "";
    const [child, kitty] = cpid ? kittyOwner(Number(cpid), procs) : [0, 0];
    const inst = new Instance({
      pid,
      pane: pane.pane_id,
      session: pane.session_name,
      window: pane.window_index,
      paneIndex: pane.pane_index,
      path: pane.pane_current_path,
      // the transcript names the session claude is in *now*; pane_title still shows the
      // one before a /clear, and is only what is left with no record, as with state
      summary: Object.keys(rec).length ? title : summaryOf(pane.pane_title),
      state,                       // "" with no record; the scrape below fills it in
      asking: rec.status === "waiting" ? (rec.waitingFor ?? "") : "",
      name: rec.name ?? "",
      sock: rec.messagingSocketPath ?? "",
      statusSince: since,
      lastWrite: state ? 0 : lastWrite(pane.pane_current_path),
      clientTty: client.client_tty ?? "",
      kittyPid: cpid ? String(child) : "",
      kittyProc: kitty ? String(kitty) : "",
    });
    found.push(inst);
    if (!state) scrape.push([inst, pane.pane_id]);
  }
  // all at once: serially, these were the whole cost of a poll on a box with several
  await Promise.all(scrape.map(async ([inst, pane]) =>
    inst.state = paneState(await capture(pane))));
  tagTabs(found);
  return found.sort((a, b) => byCodePoint(a.shortPath, b.shortPath) || a.pid - b.pid);
}

// Tab suffix for the path, only where it disambiguates: one kitty window shows one tmux
// window at a time, so the number matters only when a session holds more than one claude.
// Two in the same window get `:N.M` with the pane.
function tagTabs(found) {
  for (const i of found) {
    const peers = found.filter((p) => p.session && p.session === i.session);
    if (peers.length < 2) continue;
    const sameWindow = peers.filter((p) => p.window === i.window);
    i.tab = sameWindow.length > 1 ? `${i.window}.${i.paneIndex}` : i.window;
  }
}
