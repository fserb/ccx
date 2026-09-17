// The peer messages between the Claude Code sessions that have run in one directory, read
// out of the transcripts they are already written to. No UI here: chatLog() is the
// listing, watchChat() follows it.
//
// Undocumented internals, verified by hand against the logs on 2.1.273. A missing field
// falls back; a changed meaning would not be caught.
//
// - an INCOMING message is a `"type":"user"` line carrying `origin.kind === "peer"`, with
//   `origin.body` the text, `origin.name` the sender and `origin.msg_id` the id. The
//   record's own sessionId is the RECEIVER. The `<cross-session-message>` wrapper around
//   `message.content` is a rendering of the same thing, so `origin` is what is read
// - an OUTGOING one is `"type":"assistant"` holding a `tool_use` block named SendMessage,
//   whose `input.to` is a name ("ccx-85") or an address ("uds:/tmp/cc-socks/28789.sock").
//   The record's sessionId is the SENDER
// - **the sender's copy carries no msg_id of its own**: it is in the tool_result that
//   answers the tool_use, matched on tool_use_id, and that result's content is a
//   one-element array of `{type: "text"}` holding the JSON

const HOME = Deno.env.get("HOME") ?? "";
const CLAUDE = `${HOME}/.claude`;
const UTF8 = new TextDecoder();
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The same slug claudes.js builds: the cwd with every non-alphanumeric as `-`.
function projectDir(root, cwd) {
  return `${root}/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
}

// sessionId -> name and socket path -> name. `sessions/<pid>.json` exists only while the
// session does, so one that has exited resolves to nothing and the caller falls back to
// the sessionId. `messagingSocketPath` is the address minus its `uds:` scheme, so an
// address needs no pid parsed out of it.
function nameIndex(root) {
  const bySession = new Map(), bySocket = new Map();
  let entries;
  try {
    entries = [...Deno.readDirSync(`${root}/sessions`)];
  } catch {
    return {bySession, bySocket};
  }
  for (const e of entries) {
    if (!e.name.endsWith(".json")) continue;
    let rec;
    try {
      rec = JSON.parse(Deno.readTextFileSync(`${root}/sessions/${e.name}`));
    } catch {
      continue;
    }
    if (!rec.name) continue;
    if (rec.sessionId) bySession.set(rec.sessionId, rec.name);
    if (rec.messagingSocketPath) bySocket.set(rec.messagingSocketPath, rec.name);
  }
  return {bySession, bySocket};
}

// One reader per directory: the byte offset already parsed for each log, and every event
// seen so far. Re-reading only the tail is the point: a first pass over this directory is
// 70MB across 131 logs and 115ms, against 0.3ms for a poll that finds nothing appended.
function reader(cwd, root) {
  return {dir: projectDir(root, cwd), root, offsets: new Map(),
    events: [], receipts: new Map(), emitted: new Set()};
}

// Three substrings, and only a line holding one is worth a JSON.parse: 426 of the 14836
// lines in this directory, so the test keeps the parser off 97% of them. `msg_id` is
// bare on purpose: a receipt's JSON is a string inside the record, so on the line it reads
// `\"msg_id\"` and a quoted marker would miss every one of them.
const MARKERS = ['"kind":"peer"', '"SendMessage"', "msg_id"];

function read(r) {
  let entries;
  try {
    entries = [...Deno.readDirSync(r.dir)];
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name.endsWith(".jsonl")) continue;
    const path = `${r.dir}/${e.name}`;
    let size;
    try {
      size = Deno.statSync(path).size;
    } catch {
      continue;
    }
    const seen = r.offsets.get(path) ?? 0;
    if (size === seen) continue;
    // a log that shrank was replaced rather than appended to, so read it from the top
    const [lines, offset] = tail(path, size < seen ? 0 : seen, size);
    r.offsets.set(path, offset);
    const sessionId = e.name.slice(0, -".jsonl".length);
    for (const line of lines) parse(line, sessionId, r);
  }
}

// The bytes past `from`, cut at the last newline. The final line of a log being written is
// half a JSON object, and leaving it out of the offset is what makes it arrive whole on
// the next pass instead of being parsed once, failing, and never being looked at again.
function tail(path, from, size) {
  let f;
  try {
    f = Deno.openSync(path, {read: true});
  } catch {
    return [[], from];
  }
  try {
    f.seekSync(from, Deno.SeekMode.Start);
    const buf = new Uint8Array(size - from);
    let got = 0;
    while (got < buf.length) {
      const n = f.readSync(buf.subarray(got));
      if (n === null || n === 0) break;
      got += n;
    }
    const end = buf.subarray(0, got).lastIndexOf(10);
    if (end < 0) return [[], from];        // nothing complete yet
    return [UTF8.decode(buf.subarray(0, end)).split("\n"), from + end + 1];
  } finally {
    f.close();
  }
}

function parse(line, sessionId, r) {
  if (!MARKERS.some((m) => line.includes(m))) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;             // one unreadable line, not the end of the log
  }
  const when = Date.parse(rec.timestamp ?? "");
  const at = Number.isFinite(when) ? when / 1000 : 0;
  const origin = rec.origin ?? {};
  if (rec.type === "user" && origin.kind === "peer") {
    r.events.push({side: "in", at, sessionId, msgId: origin.msg_id ?? "",
      name: origin.name ?? "", addr: origin.from ?? "", body: origin.body ?? ""});
  }
  const content = rec.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "tool_use" && block.name === "SendMessage") {
      r.events.push({side: "out", at, sessionId, use: block.id ?? "",
        to: block.input?.to ?? "", body: block.input?.message ?? ""});
    }
    if (block?.type === "tool_result" && block.tool_use_id) {
      const id = receiptId(block.content);
      if (id) r.receipts.set(block.tool_use_id, id);
    }
  }
}

// The msg_id out of a SendMessage tool_result, or "". All 99 results here hold their JSON
// in a one-element array of text blocks, but a bare string costs one branch.
function receiptId(content) {
  const text = Array.isArray(content)
    ? content.map((b) => b?.text ?? "").join("")
    : typeof content === "string" ? content : "";
  if (!text.includes('"msg_id"')) return "";
  try {
    return JSON.parse(text).msg_id ?? "";
  } catch {
    return "";
  }
}

// A message can be on disk twice, as the sender's tool_use and as the receiver's origin
// record, and the sender's copy is the one to build on. It is written at once; the
// receiver's is appended when that session next reaches a turn boundary, so a busy agent's
// inbox is not on disk yet. 33 of 106 sends here have a receiver copy, and waiting does
// not fix it: sends 6 to 24h old are paired 19%, against 47% for the last hour. The join
// is msg_id, which paired every one of the 32 it could, bodies byte-identical; the copies
// differ in time by a median 1.75s and by as much as 966s, which is the length of the
// receiver's turn and not the wire.
//
// A row is therefore when a message was SENT. Nothing on disk says it was received until
// the receiving session finishes its turn, and for most messages here that never arrives,
// so this reader shows dispatch and cannot show delivery.

function rowsOf(r) {
  const {bySession, bySocket} = nameIndex(r.root);
  // "" is how a missing field arrives, which ?? does not catch
  const named = (id) => bySession.get(id) ?? (id ? id.slice(0, 6) : "?");
  const addressed = (to) =>
    to.startsWith("uds:") ? bySocket.get(to.slice("uds:".length)) ?? "?" : to || "?";

  const rows = [], byId = new Map();
  for (const e of r.events) {
    const row = e.side === "in"
      ? {at: e.at, from: e.name || addressed(e.addr), to: named(e.sessionId),
        body: e.body, msgId: e.msgId, sessionId: e.sessionId, side: "in"}
      : {at: e.at, from: named(e.sessionId), to: addressed(e.to), body: e.body,
        msgId: r.receipts.get(e.use) ?? "", sessionId: e.sessionId, side: "out"};
    const found = (row.msgId ? byId.get(row.msgId) : undefined) ?? twinOf(rows, row);
    const at = found ?? rows.length;
    rows[at] = found === undefined ? row : pair(rows[at], row);
    if (rows[at].msgId) byId.set(rows[at].msgId, at);
  }
  return rows.sort((a, b) =>
    a.at - b.at || byCodePoint(a.msgId, b.msgId) || byCodePoint(a.sessionId, b.sessionId));
}

// The other copy of `row` when neither carries the id to join on: 5 of 107 sends here had
// no result line yet, so the body is all that is left. Two ids that differ are two
// messages however equal the bodies, and the window is twice the 966s worst gap measured.
// An empty body never matches: the 5 empty ones here are notify_when_idle subscriptions,
// which carry no message at all and would otherwise all collapse into each other. Every
// one of the other 102 bodies in this directory is distinct.
const PAIR_WINDOW = 1800;

function twinOf(rows, row) {
  if (!row.body) return undefined;
  for (let n = rows.length - 1; n >= 0; n--) {
    const m = rows[n];
    if (m.side === row.side || m.side === "both") continue;
    if (m.msgId && row.msgId) continue;
    if (m.body !== row.body) continue;
    if (Math.abs(m.at - row.at) > PAIR_WINDOW) continue;
    return n;
  }
  return undefined;
}

// The sender's copy has the send time, the transcript holding the tool call and the
// address as it was typed; the receiver's has origin.name, which was recorded rather than
// looked up and so still names a sender that has since exited.
function pair(a, b) {
  const snd = a.side === "in" ? b : a;
  const inc = a.side === "in" ? a : b;
  return {at: snd.at, from: inc.from || snd.from, to: inc.to || snd.to, body: snd.body,
    msgId: snd.msgId || inc.msgId, sessionId: snd.sessionId, side: "both"};
}

function msgOf(row) {
  return {at: row.at, from: row.from, to: row.to, body: row.body, msgId: row.msgId,
    sessionId: row.sessionId};
}

// Every peer message seen by any session that has run in `cwd`, oldest first. `since` is
// epoch seconds and keeps what is at or after it.
export function chatLog(cwd, {since = 0, root = CLAUDE} = {}) {
  const r = reader(cwd, root);
  read(r);
  return rowsOf(r).filter((row) => row.at >= since).map(msgOf);
}

// Follow the same log: onMsg for each message after the initial read, which only seeds.
// Returns the stop. A poll and not a file watcher, since the first read is the expensive
// one and every one after it reads only the bytes appended since.
export function watchChat(cwd, onMsg, {interval = 1500, root = CLAUDE} = {}) {
  const r = reader(cwd, root);
  read(r);
  for (const row of rowsOf(r)) for (const k of keysOf(row)) r.emitted.add(k);
  const timer = setInterval(() => {
    read(r);
    for (const row of rowsOf(r)) {
      const keys = keysOf(row);
      if (keys.some((k) => r.emitted.has(k))) continue;
      for (const k of keys) r.emitted.add(k);
      onMsg(msgOf(row));
    }
  }, interval);
  return () => clearInterval(timer);
}

// A row gains its msg_id when the other copy arrives, so the id alone would emit the same
// message twice. The sender's transcript, time and body do not move under pairing.
function keysOf(row) {
  const stable = JSON.stringify([row.sessionId, row.at, row.body]);
  return row.msgId ? [row.msgId, stable] : [stable];
}
