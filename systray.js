/* The menu bar app: a tray icon of one dot per instance, and a panel that lists them.
 *
 * The model is the platform-free half (the poll, the filter, the cursor, what each key
 * means); the page is a dumb renderer that captures keys and is handed state to paint.
 *
 * Deno.Tray, Deno.BrowserWindow and Deno.dock exist only inside a built app, never under
 * `deno run`, so they are reached through one cast and guarded on `typeof`.
 */

import {
  discover, jump, loadBell, NUMBERS, PALETTE, play, rank, StateClock, stateOf, MAC, fuzzy,
} from "./claudes.js";
import {iconPng} from "./icon.js";

const POLL = 1500;          // same cadence as the TUI, so the bell lands as promptly

// ------------------------------------------------------------------------- the look

// Points on macOS and logical pixels on Wayland were close enough to the same size that
// the Python laid both panels out on these numbers; CSS pixels are the third thing that
// is the same size, so they carry over unchanged.
const WIDTH = 620;
const ROW = 24;             // one instance
const HEAD = 26;            // the filter line
const FOOT = 23;            // the key hints
const PAD = 8;
const MAX_ROWS = 12;        // past this the panel is taller than it is useful; keep typing
const HINTS = "1-0/enter jump   esc close";
const OFF = -20000;         // where a closed panel is parked, since it is never hidden

// ------------------------------------------------------------------- the global hotkey

// Carbon's RegisterEventHotKey is the one global-shortcut API that needs neither an
// Accessibility grant nor anything of the user, and it survives the move into a built app:
// both calls return noErr from inside one. 0x26 is the J key, a US-layout virtual code.
const CARBON = "/System/Library/Frameworks/Carbon.framework/Carbon";
const CMD = 0x0100, OPTION = 0x0800, CONTROL = 0x1000;
const HOTKEY = {code: 0x26, mods: CONTROL | OPTION | CMD};
const HOTKEY_NAME = "^⌥⌘J";
const REPEAT_GAP = 250;     // holding the keys repeats the event; six in a second, measured
const TOGGLE_GAP = 250;     // how long a close is remembered, so the click that closed the
                            // panel does not read as the click that opens it again

// The ctypes callback lived in a module global for this reason and so does this one:
// Carbon keeps a raw pointer, so a collected callback is a crash later, not an error now.
let HOTKEY_HANDLER = null;

/* Register the hotkey. `fn` is SCHEDULED and never called in the handler, and that is the
 * whole of what makes the hotkey work rather than kill the app.
 *
 * Carbon runs the handler on the AppKit main thread. Deno runs an UnsafeCallback invoked
 * from a foreign thread on its own JS thread and BLOCKS THE CALLER until it returns. The
 * READING calls go the other way: `tray.getBounds()` is `dispatch_sync` onto the main
 * queue (so is `panel.isVisible()`, and so is every other getter), which blocks the JS
 * thread until the main thread runs it. So a `fn()` here is a deadlock on the first
 * `tray.getBounds()` inside `show()`: main waits for JS, JS waits for main, and the app is
 * gone for good with no panel, no response to a click, no exception and no crash report.
 * Read off `sample` on a frozen one: main in DispatchEventToHandlers ->
 * _dispatch_semaphore_wait_slow, the JS thread in laufey_common::GetTrayIconBoundsMac ->
 * __DISPATCH_WAIT_FOR_QUEUE__. Measured in a built probe with the callback pushed onto the
 * main queue by `dispatch_async_f`: calling `getBounds()` inside it froze both threads at
 * the call and the 200ms heartbeat stopped in the same millisecond, while scheduling
 * returned from the handler in 1ms, read the bounds 2ms later and left the poll ticking.
 * The writing calls (`setPosition`, `focus`, `setSize`, `executeJs`, `setIcon`) are
 * `dispatch_async` and would have been safe, which is why this looks like it should work.
 *
 * `setTimeout` is enough because the body already runs on the JS thread: it turns the
 * AppKit work into an ordinary task that starts once the handler has returned and the main
 * thread is free again. A MICROTASK IS NOT ENOUGH, so this may not become an `await` or an
 * async handler: deno_core runs the microtask checkpoint before it releases the foreign
 * thread, measured at 200.1ms of blocked main thread for a `.then()` doing 200ms of work
 * against 0.1ms for this. It is also what the tray's own click gets for nothing, and why
 * `toggle()` is safe from there and not from here: a click arrives as an event on a
 * channel that the JS event loop drains, with no main thread waiting on it.
 */
function registerHotkey(fn) {
  if (!MAC) return "no global hotkey outside macOS";
  let last = 0;
  HOTKEY_HANDLER = new Deno.UnsafeCallback(
    {parameters: ["pointer", "pointer", "pointer"], result: "i32"},
    () => {
      const now = performance.now();
      if (now - last > REPEAT_GAP) {   // a held key repeats; one press is one toggle
        last = now;
        setTimeout(fn, 0);             // never fn(): the main thread is waiting on this
      }
      return 0;
    },
  );
  const carbon = Deno.dlopen(CARBON, {
    GetApplicationEventTarget: {parameters: [], result: "pointer"},
    InstallEventHandler: {
      parameters: ["pointer", "function", "u64", "buffer", "pointer", "pointer"],
      result: "i32",
    },
    RegisterEventHotKey: {
      // EventHotKeyID is eight bytes passed by value, not a pointer to them
      parameters: ["u32", "u32", {struct: ["u32", "u32"]}, "pointer", "u32", "buffer"],
      result: "i32",
    },
  });
  const target = carbon.symbols.GetApplicationEventTarget();
  const spec = new DataView(new ArrayBuffer(8));      // EventTypeSpec
  spec.setUint32(0, 0x6b657962, true);                // 'keyb', kEventClassKeyboard
  spec.setUint32(4, 5, true);                         // kEventHotKeyPressed
  carbon.symbols.InstallEventHandler(
    target, HOTKEY_HANDLER.pointer, 1n, new Uint8Array(spec.buffer), null, null);
  const id = new DataView(new ArrayBuffer(8));        // EventHotKeyID
  id.setUint32(0, 0x63636a70, true);                  // 'ccjp', ours
  id.setUint32(4, 1, true);
  const err = carbon.symbols.RegisterEventHotKey(
    HOTKEY.code, HOTKEY.mods, new Uint8Array(id.buffer), target, 0, new Uint8Array(8));
  return err ? `RegisterEventHotKey failed: ${err}` : "";
}

// --------------------------------------------------------------- the icon keeps its color

/* Make the menu bar image draw in our own colors, which Deno's tray will not.
 *
 * `tray.setIcon` reaches laufey_common::SetTrayIconMac, whose ImageFromPng hardcodes
 * `[img setSize:18x18]; [img setTemplate:YES]` (`mov w2, #0x1`, read out of the binary).
 * There is no flag and no second argument, and setIconDark goes through the same function.
 * macOS draws a template as one flat tint, so the gold is thrown away before it is ever on
 * screen.
 *
 * Undoing that is two things, and neither one is enough on its own:
 *  - CLEAR THE FLAG, but not in the turn that set the icon. SetTrayIconMac builds the
 *    image inside a block it dispatch_asyncs onto the main queue, so setIcon returns
 *    before the button has it and a clear in the same turn clears the image being
 *    replaced; at startup it is worse, since the status item is not in `[NSApp windows]`
 *    at all until ~72ms after `new Tray()`. An image that is still marked is the signal
 *    that Deno's block has run, so that is what `recolor` waits for.
 *  - MAKE THE BUTTON DRAW AGAIN. Clearing the flag on the live image repaints nothing
 *    (measured: pixel-identical screenshots). `setImage:` does, and it has to go through
 *    performSelectorOnMainThread:, since Deno's JS thread is not AppKit's main thread.
 * Deno's own image is kept rather than replaced by one of ours, so the re-apply that
 * follows an AppleInterfaceThemeChangedNotification hands the button back the same
 * un-templated object instead of a fresh marked one.
 */
let OBJC = null;

function objc() {
  if (!OBJC) {
    OBJC = Deno.dlopen("/usr/lib/libobjc.A.dylib", {
      objc_getClass: {parameters: ["buffer"], result: "pointer"},
      sel_registerName: {parameters: ["buffer"], result: "pointer"},
      msg: {name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer"},
      count: {name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "u64"},
      at: {name: "objc_msgSend", parameters: ["pointer", "pointer", "u64"], result: "pointer"},
      flag: {name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "bool"},
      setFlag: {name: "objc_msgSend",
        parameters: ["pointer", "pointer", "bool"], result: "void"},
      perform: {name: "objc_msgSend",
        parameters: ["pointer", "pointer", "pointer", "pointer", "bool"], result: "void"},
    }).symbols;
  }
  return OBJC;
}

const CSTR = new TextEncoder();
const PLACED = 25;          // ms between tries while the status item is being placed
const TRIES = 40;           // ~1s in all, against the ~72ms it takes

// The NSStatusBarButton, or null while the item has not been placed.
// NSStatusBarWindow -> NSStatusBarContentView -> NSView -> NSStatusBarButton, measured.
// `[[NSStatusBar systemStatusBar] _statusItems]` reaches the same button in two hops and
// is both private and an NSConcretePointerArray, which throws on objectAtIndex:.
function statusButton() {
  const s = objc();
  const sel = (n) => s.sel_registerName(CSTR.encode(`${n}\0`));
  const named = (o) => new Deno.UnsafePointerView(
    s.msg(s.msg(o, sel("className")), sel("UTF8String"))).getCString();

  const hunt = (view) => {
    if (view === null) return null;
    if (named(view).includes("StatusBarButton")) return view;
    const subs = s.msg(view, sel("subviews"));
    const n = Number(s.count(subs, sel("count")));
    for (let k = 0; k < n; k++) {
      const found = hunt(s.at(subs, sel("objectAtIndex:"), BigInt(k)));
      if (found) return found;
    }
    return null;
  };

  const app = s.msg(s.objc_getClass(CSTR.encode("NSApplication\0")), sel("sharedApplication"));
  const windows = s.msg(app, sel("windows"));
  const n = Number(s.count(windows, sel("count")));
  for (let k = 0; k < n; k++) {
    const w = s.at(windows, sel("objectAtIndex:"), BigInt(k));
    if (!named(w).includes("StatusBar")) continue;
    const found = hunt(s.msg(w, sel("contentView")));
    if (found) return found;
  }
  return null;
}

/* Take the template flag off the image the last `setIcon` put on the button, and make the
 * button draw it again. Retries while the item is unplaced or Deno's block has not run.
 *
 * `stale` says a newer icon is on its way, which is what keeps a retry from painting a
 * listing that has moved on.
 */
function recolor(stale, tries = 0) {
  try {
    if (stale()) return;
    const s = objc();
    const sel = (n) => s.sel_registerName(CSTR.encode(`${n}\0`));
    const button = statusButton();
    const image = button === null ? null : s.msg(button, sel("image"));
    if (image === null || !s.flag(image, sel("isTemplate"))) {
      if (tries < TRIES) setTimeout(() => recolor(stale, tries + 1), PLACED);
      return;
    }
    s.setFlag(image, sel("setTemplate:"), false);
    s.perform(button, sel("performSelectorOnMainThread:withObject:waitUntilDone:"),
      sel("setImage:"), image, false);
  } catch {
    // a monochrome icon is worth more than a menu bar app that died drawing one
  }
}

// ------------------------------------------------------------------------- the model

/* The listing, the filter, the cursor, and what each key means.
 *
 * The three hooks are how it reaches back into a UI it knows nothing about: `redraw` when
 * what is on screen has changed, `close` to put the panel away, `quit` to leave for good.
 */
class Model {
  constructor(redraw, close, quit) {
    this.clock = new StateClock();
    this.polling = false;
    this.instances = [];
    this.rows = [];
    this.filter = "";
    this.selected = null;      // the pid under the cursor, not the row number
    this.error = "";
    this.redraw = redraw;
    this.close = close;
    this.quit = quit;
  }

  // ---- the listing

  /* One poll. discover() is async, so the interval no longer waits for the poll it
   * started; the guard drops the next tick rather than letting two land out of order and
   * paint the older listing. This is the thing that runs all day, so it also owns the bell.
   */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      this.instances = this.clock.update(await discover());
    } finally {
      this.polling = false;
    }
    if (this.clock.woke.length) play();   // busy -> wait: a turn ended or a prompt is up
    this.refresh();
  }

  refresh() {
    this.rows = rank(this.instances, this.needle);
    const shown = this.rows.slice(0, MAX_ROWS);
    if (!shown.some((i) => i.pid === this.selected)) {
      this.selected = shown.length ? shown[0].pid : null;
    }
    this.redraw();
  }

  // What is actually matched: the filter with its ends trimmed. A leading space is how you
  // search for something starting with a digit, since a digit typed into an *empty* filter
  // picks a row instead.
  get needle() {
    return this.filter.trim().toLowerCase();
  }

  marks(string) {
    const found = this.needle ? fuzzy(this.needle, string) : null;
    return found ? found.idx : [];
  }

  /* What the icon draws: every instance's state, in the order the rows go in.
   *
   * Rank order fills the grid, which puts every `wait` dot first: the icon is for telling
   * you at a glance that something wants you, and reading an exact number off a menu bar
   * was never the point.
   */
  states() {
    return rank(this.instances).map((i) => i.state);
  }

  // ---- what the panel says

  // The head line's right-hand count, and its color. Gold when something waits.
  counter() {
    const waiting = this.instances.filter((i) => i.state === "wait").length;
    if (this.filter) {
      return {text: `${this.rows.length} of ${this.instances.length}`, color: PALETTE.mauve};
    }
    return {
      text: `${waiting}/${this.instances.length}`,
      color: waiting ? PALETTE.gold : PALETTE.mauve,
    };
  }

  empty() {
    return this.instances.length ? "nothing matches" : "no claude instances";
  }

  note() {
    if (this.error) return {text: this.error, color: PALETTE.error};
    if (this.rows.length > MAX_ROWS) {
      return {text: `+${this.rows.length - MAX_ROWS} more, keep typing`, color: PALETTE.dim};
    }
    return {text: "", color: PALETTE.dim};
  }

  height() {
    const rows = Math.min(Math.max(this.rows.length, 1), MAX_ROWS);
    return PAD + HEAD + rows * ROW + FOOT + PAD;
  }

  // Everything the page paints, in one object. This is the drawRect_ of the HTML backend:
  // the model says what is on screen and the page decides nothing.
  view() {
    return {
      filter: this.filter,
      counter: this.counter(),
      empty: this.rows.length ? "" : this.empty(),
      note: this.note(),
      hints: HINTS,
      rows: this.rows.slice(0, MAX_ROWS).map((inst, n) => {
        const state = stateOf(inst);
        return {
          num: n < NUMBERS.length ? NUMBERS[n] : " ",
          label: state.label,
          color: state.color,
          age: inst.age,
          path: inst.shortPath,
          pathHits: this.marks(inst.shortPath),
          summary: inst.summary,
          sumHits: this.marks(inst.summary),
          sumColor: inst.state === "wait" ? PALETTE.text : PALETTE.idle,
          on: inst.pid === this.selected,
        };
      }),
    };
  }

  // ---- the cursor and the jump

  /* Called every time the panel comes up: a fresh filter, no stale error, and the cursor
   * back on the top row.
   *
   * Dropping `selected` is what puts it there: `refresh` only moves the cursor when the pid
   * under it is gone, so without this the panel comes up on whatever row you left it on,
   * which is the wrong row now that the ranking has been redone. The TUI keeps its cursor
   * for the opposite reason: it stays open and you watch the rows move under it.
   */
  opened() {
    this.filter = "";
    this.error = "";
    this.selected = null;
    this.refresh();
  }

  selectedRow() {
    const n = this.rows.findIndex((i) => i.pid === this.selected);
    return n < 0 ? 0 : n;
  }

  move(delta) {
    if (!this.rows.length) return;
    const last = Math.min(this.rows.length, MAX_ROWS) - 1;
    this.selected = this.rows[Math.min(Math.max(this.selectedRow() + delta, 0), last)].pid;
    this.redraw();
  }

  /* Focus that instance and put the panel away.
   *
   * Unlike the TUI, jumping closes: this is a launcher you called up to leave, not a window
   * you are already sitting in. A jump that failed says so instead of closing, since a
   * panel that vanished having done nothing is indistinguishable from one that worked.
   */
  async jumpRow(row) {
    if (!(row >= 0 && row < Math.min(this.rows.length, MAX_ROWS))) return;
    this.selected = this.rows[row].pid;
    const err = await jump(this.rows[row]);
    if (err) {
      this.error = err;
      this.redraw();
      return;
    }
    this.close();
  }

  // ---- the keyboard

  /* One keystroke. `name` is set for the keys that are not text, `char` otherwise.
   *
   * A digit typed into an *empty* filter picks that row. Once the filter has anything in it
   * a digit is just another filter character, and a leading space is how you search for
   * something that starts with one. Escape only closes the panel: the panel is something
   * the app shows, so leaving it is not leaving, and "quit" is the one key that ends the
   * process.
   */
  key(name = "", char = "") {
    if (name === "escape") this.close();
    else if (name === "quit") this.quit();
    else if (name === "enter") this.jumpRow(this.selectedRow());
    else if (name === "backspace") {
      this.filter = this.filter.slice(0, -1);
      this.refresh();
    } else if (name === "down" || name === "up") this.move(name === "down" ? 1 : -1);
    else if (!this.filter && char.length === 1 && NUMBERS.includes(char)) {
      this.jumpRow(NUMBERS.indexOf(char));
    } else if (char.length === 1 && char >= " ") {
      this.filter += char;
      this.refresh();
    }
  }
}

// -------------------------------------------------------------------------- the page

/* The panel, as one HTML document served off loopback. Five columns at fixed offsets, so
 * it lines up with the TUI. The path truncates at its HEAD, which keeps the part that
 * identifies it; `direction: rtl` on the box is how CSS spells that.
 *
 * The state is embedded in the document as well as pushed in afterwards, so the page is
 * never blank: point a browser at the same URL and it paints the real listing.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>ccx</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  height: 100%; overflow: hidden; background: ${PALETTE.panelBg}; color: ${PALETTE.text};
  font: 16px/21px Inconsolata, monospace; cursor: default;
  -webkit-user-select: none; user-select: none;
}
#head { position: absolute; left: ${PAD + 2}px; top: ${PAD}px; width: ${WIDTH - 2 * PAD}px;
  height: ${HEAD - 6}px; }
#count { position: absolute; right: 0; top: 0; }
#rule { position: absolute; left: 0; top: ${PAD + HEAD - 5}px; width: 100%; height: 1px;
  background: ${PALETTE.edge}; }
#rows { position: absolute; left: 0; top: ${PAD + HEAD}px; width: 100%; }
#empty { position: absolute; left: ${PAD + 2}px; top: 3px; color: ${PALETTE.dim}; }
.row { position: relative; height: ${ROW}px; }
.row.on { background: ${PALETTE.cursor}; }
.row > span { position: absolute; top: 3px; height: 21px; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; }
.num { left: 10px; width: 14px; color: ${PALETTE.dim}; }
.state { left: 28px; width: 52px; font-weight: bold; }
.age { left: 84px; width: 34px; text-align: right; color: ${PALETTE.dim}; }
/* direction: rtl truncates at the head, which keeps the part of a path that identifies it,
   and text-align: left puts back the alignment that rtl otherwise takes with it */
.path { left: 126px; width: 196px; color: ${PALETTE.mauve}; direction: rtl;
  text-align: left; }
.path > i { font-style: normal; direction: ltr; unicode-bidi: embed; }
.sum { left: 330px; width: ${WIDTH - 330 - PAD}px; }
.m { color: ${PALETTE.accent}; font-weight: bold; }
#foot { position: absolute; left: ${PAD + 2}px; width: ${WIDTH - 2 * PAD}px; bottom: 4px;
  height: ${FOOT - 4}px; }
#hints { position: absolute; right: 0; top: 0; color: ${PALETTE.dim}; }
</style>
<div id="head"><span id="filter"></span><span id="count"></span></div>
<div id="rule"></div>
<div id="rows"></div>
<div id="foot"><span id="note"></span><span id="hints"></span></div>
<script>
const $ = (id) => document.getElementById(id);

// One field, with the fuzzy match's characters picked out in the accent color. Built as
// nodes rather than markup so a path or a summary can hold anything at all.
function field(cls, string, color, hits) {
  const box = document.createElement("span");
  box.className = cls;
  if (color) box.style.color = color;
  const marked = new Set(hits ?? []);
  const inner = cls === "path" ? box.appendChild(document.createElement("i")) : box;
  let run = null;
  for (let n = 0; n < string.length; n++) {
    const hit = marked.has(n);
    if (!run || hit !== run.hit) {
      run = {hit, node: document.createElement("span")};
      run.node.className = hit ? "m" : "";
      inner.appendChild(run.node);
    }
    run.node.textContent += string[n];
  }
  return box;
}

function ccx(state) {
  $("filter").textContent = state.filter ? "/" + state.filter : "type to filter";
  $("filter").style.color = state.filter ? "${PALETTE.accent}" : "${PALETTE.hint}";
  $("count").textContent = state.counter.text;
  $("count").style.color = state.counter.color;
  $("note").textContent = state.note.text;
  $("note").style.color = state.note.color;
  $("hints").textContent = state.hints;

  const rows = $("rows");
  rows.textContent = "";
  if (state.empty) {
    const none = document.createElement("div");
    none.id = "empty";
    none.textContent = state.empty;
    rows.appendChild(none);
  }
  for (const r of state.rows) {
    const row = document.createElement("div");
    row.className = r.on ? "row on" : "row";
    row.appendChild(field("num", r.num, null, null));
    row.appendChild(field("state", r.label, r.color, null));
    row.appendChild(field("age", r.age, null, null));
    row.appendChild(field("path", r.path, null, r.pathHits));
    row.appendChild(field("sum", r.summary, r.sumColor, r.sumHits));
    rows.appendChild(row);
  }
}

// The keys the model answers to, in the browser's spelling. cmd+q and ctrl+q both arrive
// as "q" here: the AppKit backend had to read charactersIgnoringModifiers because ctrl+q
// reached it as \\x11, and a KeyboardEvent has no such problem.
const NAMED = {Escape: "escape", Enter: "enter", Backspace: "backspace",
  ArrowDown: "down", ArrowUp: "up"};

addEventListener("keydown", (e) => {
  const send = (name, char) => {
    e.preventDefault();
    if (window.bindings) window.bindings.ccxKey(name, char);
  };
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "q") return send("quit", "");
  if (NAMED[e.key]) return send(NAMED[e.key], "");
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) return send("", e.key);
});

$("rows").addEventListener("mousedown", (e) => {
  const row = e.target.closest(".row");
  if (row && window.bindings) window.bindings.ccxClick([...$("rows").children].indexOf(row));
});
</script>
`;

// `<` is escaped out of the state so a path or a summary holding "</script>" cannot end
// the tag it is embedded in.
function json(view) {
  return JSON.stringify(view).replaceAll("<", "\\u003c");
}

// The document with the current listing already painted into it.
function pageWith(view) {
  return `${PAGE}<script>ccx(${json(view)})</script>\n`;
}

// ---------------------------------------------------------------------------- the app

// The desktop globals are not in Deno's types, and they are absent under `deno run`.
const desktop = /** @type {any} */ (Deno);

/* Close the window the first `BrowserWindow` adopted, as soon as the panel is up.
 *
 * CLOSE AND NOT HIDE. `hide()` on it is not durable: it takes (`isVisible()` goes false
 * and the window leaves the screen), and then the runtime puts it back up ~5s later and it
 * stays for the life of the app, still on screen at 65s, buried a dozen windows deep where
 * it is easy to miss. `close()` holds: `isClosed` is true at 10s and 20s and the window is
 * gone from the CG list entirely. A poll of ours is not what re-shows it; a probe with no
 * poll, no setIcon and no setSize does the same.
 *
 * `close()` also does not need the window ordered in first, which `hide()` does, so
 * nothing here waits for the runtime's ~250ms order-in and the adopted window never
 * reaches the screen at all. Waiting for it cost a 130-140ms flash of a blank 800x628
 * window, measured over three runs.
 *
 * The one thing that IS waited for is the panel, because DISPOSING OF THE LAST VISIBLE
 * WINDOW ENDS THE PROCESS: status 0, no exception, no crash report, and the next timer
 * never runs. That is the real rule behind "hide() kills the app", and it is about the
 * window being the last one and not about it being borderless. The panel is visible at
 * 78-110ms, well before the adopted window is. The deadline is there so a runtime that
 * never shows the panel costs a second at startup instead of hanging.
 */
async function closeAdopted(adopted, panel) {
  const deadline = Date.now() + 4000;
  while (!panel.isVisible() && Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 25));
  }
  adopted.close();
}

/* Put the panel under the tray icon, right-aligned to it. getBounds is only meaningful
 * once the item has been placed: at construction it reads {x: 8, y: 1106} and at the
 * first show {x: 1008, y: 5}, which is why this is a callback and not read once.
 */
function place(bounds) {
  return {
    x: Math.round(Math.max(8, bounds.x + bounds.width - WIDTH)),
    y: Math.round(bounds.y + bounds.height + 4),
  };
}

/* The menu bar app. Never returns; the OS ends it.
 *
 * Returns 1 without starting anything when the desktop globals are missing, which is every
 * way of running this other than the built app.
 */
export async function runSystray(argv = Deno.args) {
  if (typeof desktop.Tray !== "function") {
    console.error("the systray is the built app: ./task build, then ccx systray");
    return 1;
  }
  await loadBell();          // play() is a no-op until this has run, and a poll cannot await

  let drawn = null;          // the ordered state list the icon last drew
  let sized = 0;             // the height the panel was last set to

  const model = new Model(redraw, () => close(), () => Deno.exit(0));

  const server = Deno.serve(
    {port: 0, hostname: "127.0.0.1", onListen: () => {}},
    () => new Response(pageWith(model.view()),
      {headers: {"content-type": "text/html; charset=utf-8"}}),
  );

  const tray = new desktop.Tray();
  tray.setTooltip("ccx");
  // The only menu the app has, and the only way out other than the panel's own quit key: a
  // menu bar app with no window has nowhere else to put it. It opens on right click, which
  // the OS reserves and never reports, so nothing here can open it and nothing has to
  // suppress it on a left click the way the AppKit version did.
  tray.setMenu([
    {item: {id: "about", label: `ccx  ·  ${HOTKEY_NAME}`, enabled: false,
      accelerator: null, checked: false, tooltip: null}},
    {separator: null},
    {item: {id: "quit", label: "Quit", enabled: true, accelerator: null, checked: false,
      tooltip: null}},
  ]);
  tray.onmenuclick = () => model.quit();   // Quit is the only thing in it that can be hit

  /* The panel is a window we own, shown, hidden and placed by hand.
   *
   * `tray.attachPanel` is documented as the menu bar popover primitive and in 2.9.6 it is
   * not one: it gives a plain titled window with traffic lights on it, and it ignores both
   * the icon's position and the creation options that would make it a panel. Owning the
   * window is the same three methods the AppKit version had, for the same reasons.
   *
   * TWO THINGS ABOUT IT ARE NOT GUESSABLE, and both were read off the live NSWindow's
   * styleMask through objc_msgSend rather than inferred from how it looks (titled is bit 0,
   * so mask 0 is borderless and 7 and 15 are not).
   *
   * THE RUNTIME OPENS ONE WINDOW AT STARTUP AND THE FIRST `BrowserWindow` ADOPTS IT. That
   * one is an ordinary titled window whatever options it is handed, mask 7, which is where
   * the traffic lights came from. The *second* one built in the same process is a
   * `LaufeyKeyableWindow` at mask 0: borderless, and still `canBecomeKeyWindow`, which is
   * the NSPanel subclass the AppKit version had to write by hand. So the startup window is
   * taken and closed, and the panel is built second. `deno desktop` points that window at
   * our own `Deno.serve` address, so left alone it sits there showing the listing: an
   * 800x628 copy of the panel with traffic lights on it. `closeAdopted` says why closing
   * is the only thing that disposes of it.
   *
   * The option set is not the obvious one either. `frameless` ALONE IS IGNORED, mask 15; it
   * only bites together with `resizable: false`. `noActivate` is a trap rather than the
   * answer: it gives mask 128, NSWindowStyleMaskNonactivatingPanel, and takes
   * `canBecomeKeyWindow` to 0, so the panel can no longer be typed into. And every option
   * goes to the constructor with nothing configured afterwards, since the mask is applied
   * asynchronously and a later setter undoes it: `alwaysOnTop` in the constructor keeps
   * mask 0, `setAlwaysOnTop(true)` called after it drops back to 7.
   */
  const adopted = new desktop.BrowserWindow();   // the startup window, taken off our hands

  const panel = new desktop.BrowserWindow({
    width: WIDTH, height: PAD + HEAD + MAX_ROWS * ROW + FOOT + PAD,
    frameless: true, resizable: false, alwaysOnTop: true,
  });
  panel.navigate(`http://127.0.0.1:${server.addr.port}/`);
  panel.setPosition(OFF, OFF);
  panel.bind("ccxKey", (name, char) => model.key(name ?? "", char ?? ""));
  panel.bind("ccxClick", (row) => model.jumpRow(row));
  panel.onblur = () => close();

  let open = false;          // whether the panel is up; the window cannot be asked
  let hiddenAt = 0;          // when the panel last went away, for the toggle's memory

  /* Closing the panel PARKS IT OFF SCREEN AND NEVER HIDES IT, which reads as a silly thing
   * to do and is not: `panel.hide()` on the frameless window KILLS THE APP. The call
   * returns, the line after it runs, and the process is gone with status 0 before the next
   * timer fires: no exception, no crash report, no `unload`, and a wrapped `Deno.exit`
   * never sees it, so it is AppKit tearing the app down and not anything in JS. It is
   * specific to the borderless second window; `hide()` on the adopted startup window above
   * is fine, which is what makes this so easy to "fix" back into a menu bar app that dies a
   * few seconds after launch.
   *
   * So `isVisible()` is true for the whole life of the process and cannot answer whether
   * the panel is up. `open` is what answers that, and `onblur` is what closes it.
   */
  function show() {
    // getBounds is a drifting placeholder at x=8 for the first ~400ms after the tray is
    // constructed and only then settles to where the item really is, so it is read here,
    // at the moment it is needed, and never once at setup
    const at = place(tray.getBounds());
    panel.setPosition(at.x, at.y);
    panel.focus();
    open = true;
    model.opened();
  }

  function close() {
    if (!open) return;
    panel.setPosition(OFF, OFF);
    open = false;
    hiddenAt = Date.now();
  }

  /* One toggle for the menu bar icon and the hotkey both.
   *
   * Clicking the icon while the panel is up makes the status bar key, so the panel blurs
   * and hides before the button action runs. Without the memory that click reads as "it is
   * closed, open it" and the panel flickers shut and straight back open. The hotkey arrives
   * with the panel still key and does not have the problem, and goes through the same door
   * anyway.
   */
  function toggle() {
    if (open) return close();
    if (Date.now() - hiddenAt < TOGGLE_GAP) return;   // this click is what blurred it
    show();
  }

  tray.onclick = () => toggle();

  // Not a line earlier: the panel blurs while this waits, `onblur` runs `close()`, and
  // `close` reads `open`. Awaiting above that `let` put the read in the temporal dead zone,
  // and the ReferenceError came out of an event handler, where it is uncaught and ends the
  // process. Launched from a terminal the blur never arrived and it looked fine; launched
  // by LaunchServices, which is how `ccx systray` starts it, the app died at ~300ms every
  // time.
  await closeAdopted(adopted, panel);

  /* Redraw the menu bar dots, if what they would say has changed.
   *
   * The states in rank order are the whole of the icon, so comparing that list is exactly
   * the redraw test and a poll where nothing moved encodes no PNG. It has to be the ordered
   * list and not the counts, since which dot is which color is what moves when a session
   * changes state. The list is checked again after the encode, so two polls in flight
   * cannot leave the older one's image on the bar.
   */
  async function reicon(states) {
    const key = states.join(",");
    if (key === drawn) return;
    drawn = key;
    const png = await iconPng(states);
    if (key !== drawn) return;
    tray.setIcon(png);
    recolor(() => key !== drawn);   // it arrives marked as a template; see above
  }

  function redraw() {
    reicon(model.states());
    const height = model.height();
    if (height !== sized) {
      sized = height;
      panel.setSize(WIDTH, height);          // while hidden too, so an open is never resized
    }
    // executeJs on a page that has not finished loading is the only way this rejects, and
    // the document it loads carries the same state anyway
    panel.executeJs(`ccx(${json(model.view())})`).catch(() => {});
  }

  desktop.dock?.setVisible(false);   // no dock icon; Deno.dock is macOS only
  const err = registerHotkey(() => toggle());
  if (err) console.error(`${err}; the menu bar icon still works`);

  await model.poll();
  setInterval(() => model.poll(), POLL);
  // the only way to look at the panel from a script: clicking the icon needs a mouse and
  // pressing the hotkey needs a person
  if (argv.includes("--show")) setTimeout(show, 600);   // after getBounds has settled
  return 0;
}
