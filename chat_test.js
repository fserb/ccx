// `deno test -A --ext js chat_test.js`. Fixtures only, never the live logs: they are
// written to while the suite runs. `root` is the .claude directory, so one temp dir gives
// both halves of it, projects/ and sessions/, and the real one is not touched.

import {chatLog, watchChat} from "./chat.js";

// the two assertions ccx_test.js writes for itself, since the project takes no
// dependencies and `deno test` brings no assertion library of its own

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

// the fixtures

const CWD = "/Users/fserb/prj/demo";
const SLUG = "-Users-fserb-prj-demo";
const SEND = "ccc11111-1111-1111-1111-111111111111";
const RECV = "ddd22222-2222-2222-2222-222222222222";
const GONE = "eee33333-3333-3333-3333-333333333333";
const SOCK = "uds:/tmp/cc-socks/28789.sock";

const epoch = (iso) => Date.parse(iso) / 1000;

function root() {
  const dir = Deno.makeTempDirSync({prefix: "ccx-chat-"});
  Deno.mkdirSync(`${dir}/projects/${SLUG}`, {recursive: true});
  Deno.mkdirSync(`${dir}/sessions`, {recursive: true});
  return dir;
}

function session(dir, pid, sessionId, name) {
  Deno.writeTextFileSync(`${dir}/sessions/${pid}.json`, JSON.stringify(
    {pid, sessionId, name, cwd: CWD, messagingSocketPath: `/tmp/cc-socks/${pid}.sock`}));
}

function log(dir, sessionId, lines) {
  const text = lines.map((l) => typeof l === "string" ? l : JSON.stringify(l)).join("\n");
  Deno.writeTextFileSync(`${dir}/projects/${SLUG}/${sessionId}.jsonl`, `${text}\n`);
}

function append(dir, sessionId, text) {
  Deno.writeTextFileSync(`${dir}/projects/${SLUG}/${sessionId}.jsonl`, text, {append: true});
}

// what the receiver's transcript holds. The text is origin.body; the wrapper in
// message.content is a rendering of the same thing and nothing reads it
function incoming(at, {name, body, msgId, from = SOCK}) {
  return {type: "user", timestamp: at, sessionId: RECV, userType: "external", isMeta: true,
    promptSource: "system",
    origin: {kind: "peer", from, verifiedPeerPid: 28789, msg_id: msgId, name,
      fromMode: "prompting", body},
    message: {role: "user",
      content: `<cross-session-message from="${from}">${body}</cross-session-message>`}};
}

// and the sender's: the tool_use, then the tool_result that carries the msg_id back
function outgoing(at, {to, body, use, sessionId = SEND}) {
  return {type: "assistant", timestamp: at, sessionId,
    message: {role: "assistant", content: [
      {type: "tool_use", id: use, name: "SendMessage",
        input: {to, summary: "s", message: body}}]}};
}

function receipt(at, {use, msgId, sessionId = SEND}) {
  return {type: "user", timestamp: at, sessionId,
    message: {role: "user", content: [
      {type: "tool_result", tool_use_id: use,
        content: [{type: "text", text: JSON.stringify({success: true, msg_id: msgId})}]}]}};
}

// chatLog

Deno.test("chatLog: an incoming record is one message, named out of origin", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40694, RECV, "ccx-49");
  log(dir, RECV, [incoming("2026-09-16T17:51:07.696Z",
    {name: "ccx-ef", body: "do the thing", msgId: "m1"})]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "one record is one message");
  eq(out[0].from, "ccx-ef", "from is origin.name");
  eq(out[0].to, "ccx-49", "to is the transcript that received it");
  eq(out[0].body, "do the thing", "body is origin.body, with no envelope");
  eq(out[0].msgId, "m1", "msgId is origin.msg_id");
  eq(out[0].sessionId, RECV, "sessionId is the log the line came out of");
  eq(out[0].at, epoch("2026-09-16T17:51:07.696Z"), "at is the timestamp in seconds");
});

Deno.test("chatLog: an outgoing tool_use is one message, sender out of the transcript", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [outgoing("2026-09-16T17:51:06.000Z",
    {to: "ccx-85", body: "port the TUI", use: "toolu_1"})]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "one tool_use is one message");
  eq(out[0].from, "ccx-ef", "from is the sending session's name");
  eq(out[0].to, "ccx-85", "to is input.to");
  eq(out[0].body, "port the TUI", "body is input.message");
  eq(out[0].msgId, "", "no tool_result yet, so no id to carry");
});

Deno.test("chatLog: the sender's msg_id is in the tool_result, not the tool_use", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [
    outgoing("2026-09-16T17:51:06.000Z", {to: "ccx-85", body: "hi", use: "toolu_1"}),
    receipt("2026-09-16T17:51:06.100Z", {use: "toolu_1", msgId: "m9"}),
  ]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "the receipt is not a message of its own");
  eq(out[0].msgId, "m9", "the id joins to the tool_use on tool_use_id");
});

Deno.test("chatLog: both copies of one message collapse into one row with both names", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40694, RECV, "ccx-49");
  log(dir, SEND, [
    outgoing("2026-09-16T17:51:06.000Z",
      {to: "ccx-49", body: "do the thing", use: "toolu_1"}),
    receipt("2026-09-16T17:51:06.100Z", {use: "toolu_1", msgId: "m1"}),
  ]);
  log(dir, RECV, [incoming("2026-09-16T17:51:07.750Z",
    {name: "ccx-ef", body: "do the thing", msgId: "m1"})]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "on disk twice, in the listing once");
  eq([out[0].from, out[0].to], ["ccx-ef", "ccx-49"], "the row carries both ends");
  eq(out[0].at, epoch("2026-09-16T17:51:06.000Z"),
    "the send time, not the receiver's, which lands a median 1.75s later");
  eq(out[0].sessionId, SEND, "the sender's transcript holds the tool call");
});

Deno.test("chatLog: two ids that differ stay two rows, however equal the bodies", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40694, RECV, "ccx-49");
  log(dir, SEND, [
    outgoing("2026-09-16T17:51:06.000Z", {to: "ccx-49", body: "ok", use: "toolu_1"}),
    receipt("2026-09-16T17:51:06.100Z", {use: "toolu_1", msgId: "m1"}),
    outgoing("2026-09-16T17:52:06.000Z", {to: "ccx-49", body: "ok", use: "toolu_2"}),
    receipt("2026-09-16T17:52:06.100Z", {use: "toolu_2", msgId: "m2"}),
  ]);
  log(dir, RECV, [
    incoming("2026-09-16T17:51:07.000Z", {name: "ccx-ef", body: "ok", msgId: "m1"}),
    incoming("2026-09-16T17:52:07.000Z", {name: "ccx-ef", body: "ok", msgId: "m2"}),
  ]);
  eq(chatLog(CWD, {root: dir}).map((m) => m.msgId), ["m1", "m2"],
    "the id decides, so an identical body is not a merge");
});

Deno.test("chatLog: a send with no receipt still pairs, on the body inside the window", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40694, RECV, "ccx-49");
  log(dir, SEND, [outgoing("2026-09-16T17:51:06.000Z",
    {to: "ccx-49", body: "no receipt for this one", use: "toolu_1"})]);
  log(dir, RECV, [incoming("2026-09-16T17:51:07.750Z",
    {name: "ccx-ef", body: "no receipt for this one", msgId: "m1"})]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "5 of 107 sends here have no receipt, and must not double");
  eq([out[0].from, out[0].to], ["ccx-ef", "ccx-49"], "both ends survive the body join");
  eq(out[0].msgId, "m1", "the id the receiver had");
});

Deno.test("chatLog: a receiver 16 minutes behind still pairs, not doubles", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40694, RECV, "ccx-49");
  // the widest gap measured, a receiver that stayed mid-turn for 16 minutes, and a send
  // with no receipt, so the body is the only join left
  log(dir, SEND, [outgoing("2026-09-16T00:24:42.000Z",
    {to: "ccx-49", body: "answered late", use: "toolu_1"})]);
  log(dir, RECV, [incoming("2026-09-16T00:40:49.000Z",
    {name: "ccx-ef", body: "answered late", msgId: "m1"})]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "966s apart is still one message");
  eq(out[0].at, epoch("2026-09-16T00:24:42.000Z"), "timed at the send, not the arrival");
});

Deno.test("chatLog: empty bodies never join each other", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40694, RECV, "ccx-49");
  // notify_when_idle sends carry no message, and 5 of the 107 here are that shape
  log(dir, SEND, [
    outgoing("2026-09-16T17:51:00.000Z", {to: "ccx-49", body: "", use: "toolu_1"}),
    outgoing("2026-09-16T17:51:30.000Z", {to: "ccx-73", body: "", use: "toolu_2"}),
  ]);
  log(dir, RECV, [incoming("2026-09-16T17:51:02.000Z",
    {name: "ccx-ef", body: "", msgId: "m1"})]);
  eq(chatLog(CWD, {root: dir}).length, 3, "three sends with no body are three rows");
});

Deno.test("chatLog: the same body an hour apart is two messages, not one", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [outgoing("2026-09-16T17:51:06.000Z",
    {to: "ccx-49", body: "same", use: "toolu_1"})]);
  log(dir, RECV, [incoming("2026-09-16T18:51:06.000Z",
    {name: "ccx-ef", body: "same", msgId: "m1"})]);
  eq(chatLog(CWD, {root: dir}).length, 2, "the body join is bounded by PAIR_WINDOW");
});

Deno.test("chatLog: a session with no record falls back to 6 characters of its id", () => {
  const dir = root();
  log(dir, GONE, [outgoing("2026-09-16T17:51:06.000Z",
    {sessionId: GONE, to: "uds:/tmp/cc-socks/99999.sock", body: "from a dead session",
      use: "toolu_1"})]);
  const out = chatLog(CWD, {root: dir});
  eq(out.length, 1, "a session that exited is still a row");
  eq(out[0].from, GONE.slice(0, 6), "the id's head, not a dropped row");
  eq(out[0].to, "?", "an address with no live record behind it");
});

Deno.test("chatLog: an address resolves through the socket path a record carries", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  session(dir, 40613, RECV, "ccx-85");
  log(dir, SEND, [outgoing("2026-09-16T17:51:06.000Z",
    {to: "uds:/tmp/cc-socks/40613.sock", body: "addressed", use: "toolu_1"})]);
  eq(chatLog(CWD, {root: dir})[0].to, "ccx-85", "messagingSocketPath is the whole map");
});

Deno.test("chatLog: a half-written last line is skipped, and the rest survives", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  const whole = JSON.stringify(
    outgoing("2026-09-16T17:51:06.000Z", {to: "ccx-49", body: "first", use: "toolu_1"}));
  const partial = JSON.stringify(
    outgoing("2026-09-16T17:51:08.000Z", {to: "ccx-49", body: "second", use: "toolu_2"}));
  Deno.writeTextFileSync(`${dir}/projects/${SLUG}/${SEND}.jsonl`,
    `${whole}\n${partial.slice(0, 60)}`);
  const out = chatLog(CWD, {root: dir});
  eq(out.map((m) => m.body), ["first"], "half a JSON object is not a message");
});

Deno.test("chatLog: a complete line that is not JSON costs only that line", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [
    "{ this SendMessage line is not json",
    outgoing("2026-09-16T17:51:06.000Z",
      {to: "ccx-49", body: "after the garbage", use: "toolu_1"}),
  ]);
  eq(chatLog(CWD, {root: dir}).map((m) => m.body), ["after the garbage"],
    "one unreadable line, not the end of the log");
});

Deno.test("chatLog: oldest first, across two transcripts", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [
    outgoing("2026-09-16T17:53:00.000Z", {to: "ccx-49", body: "third", use: "toolu_3"}),
    outgoing("2026-09-16T17:51:00.000Z", {to: "ccx-49", body: "first", use: "toolu_1"}),
  ]);
  log(dir, RECV, [incoming("2026-09-16T17:52:00.000Z",
    {name: "ccx-9c", body: "second", msgId: "m2"})]);
  eq(chatLog(CWD, {root: dir}).map((m) => m.body), ["first", "second", "third"],
    "time order, not file order");
});

Deno.test("chatLog: since keeps what is at or after it", () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [
    outgoing("2026-09-16T17:51:00.000Z", {to: "ccx-49", body: "before", use: "toolu_1"}),
    outgoing("2026-09-16T17:53:00.000Z", {to: "ccx-49", body: "after", use: "toolu_2"}),
  ]);
  eq(chatLog(CWD, {root: dir, since: epoch("2026-09-16T17:52:00.000Z")}).map((m) => m.body),
    ["after"], "what is older than since is gone");
  eq(chatLog(CWD, {root: dir, since: epoch("2026-09-16T17:53:00.000Z")}).map((m) => m.body),
    ["after"], "a message exactly at since is kept");
});

Deno.test("chatLog: a directory that does not exist is an empty log", () => {
  eq(chatLog("/nowhere/at/all", {root: root()}), [], "no project dir is no messages");
});

// watchChat

async function until(test, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

Deno.test("watchChat: the initial read seeds, and what lands after it is delivered",
  async () => {
    const dir = root();
    session(dir, 28789, SEND, "ccx-ef");
    log(dir, SEND, [outgoing("2026-09-16T17:51:00.000Z",
      {to: "ccx-49", body: "already there", use: "toolu_1"})]);
    const seen = [];
    const stop = watchChat(CWD, (m) => seen.push(m), {interval: 30, root: dir});
    try {
      await new Promise((r) => setTimeout(r, 120));
      eq(seen, [], "the seed is not delivered");
      append(dir, SEND, `${JSON.stringify(outgoing("2026-09-16T17:52:00.000Z",
        {to: "ccx-49", body: "landed later", use: "toolu_2"}))}\n`);
      ok(await until(() => seen.length === 1), "the appended message never arrived");
      eq(seen[0].body, "landed later", "the new message, whole");
      eq(seen[0].from, "ccx-ef", "and named");
    } finally {
      stop();
    }
  });

Deno.test("watchChat: a line that arrives in two writes is read whole, once", async () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, [outgoing("2026-09-16T17:51:00.000Z",
    {to: "ccx-49", body: "already there", use: "toolu_1"})]);
  const seen = [];
  const stop = watchChat(CWD, (m) => seen.push(m), {interval: 30, root: dir});
  try {
    const line = JSON.stringify(outgoing("2026-09-16T17:52:00.000Z",
      {to: "ccx-49", body: "written in halves", use: "toolu_2"}));
    append(dir, SEND, line.slice(0, 70));
    await new Promise((r) => setTimeout(r, 120));
    eq(seen, [], "the first half is not a message");
    append(dir, SEND, `${line.slice(70)}\n`);
    ok(await until(() => seen.length === 1), "the completed line never arrived");
    eq(seen[0].body, "written in halves", "re-read whole rather than lost");
  } finally {
    stop();
  }
});

Deno.test("watchChat: the receiver's copy of a delivered message is not a second row",
  async () => {
    const dir = root();
    session(dir, 28789, SEND, "ccx-ef");
    session(dir, 40694, RECV, "ccx-49");
    log(dir, SEND, [outgoing("2026-09-16T17:51:00.000Z",
      {to: "ccx-49", body: "seed", use: "toolu_0"})]);
    const seen = [];
    const stop = watchChat(CWD, (m) => seen.push(m), {interval: 30, root: dir});
    try {
      append(dir, SEND, `${JSON.stringify(outgoing("2026-09-16T17:52:00.000Z",
        {to: "ccx-49", body: "one message", use: "toolu_1"}))}\n`);
      ok(await until(() => seen.length === 1), "the send never arrived");
      // the receipt gives that row an id it did not have, and the receiver's copy lands
      // after it: neither may come back as a message of its own
      append(dir, SEND, `${JSON.stringify(receipt("2026-09-16T17:52:00.100Z",
        {use: "toolu_1", msgId: "m1"}))}\n`);
      log(dir, RECV, [incoming("2026-09-16T17:52:01.750Z",
        {name: "ccx-ef", body: "one message", msgId: "m1"})]);
      await new Promise((r) => setTimeout(r, 200));
      eq(seen.length, 1, "one message, delivered once");
      eq(chatLog(CWD, {root: dir}).length, 2, "the seed and this one");
    } finally {
      stop();
    }
  });

Deno.test("watchChat: stop ends the polling", async () => {
  const dir = root();
  session(dir, 28789, SEND, "ccx-ef");
  log(dir, SEND, []);
  const seen = [];
  const stop = watchChat(CWD, (m) => seen.push(m), {interval: 20, root: dir});
  stop();
  append(dir, SEND, `${JSON.stringify(outgoing("2026-09-16T17:52:00.000Z",
    {to: "ccx-49", body: "after the stop", use: "toolu_1"}))}\n`);
  await new Promise((r) => setTimeout(r, 120));
  eq(seen, [], "nothing is delivered after the stop");
});
