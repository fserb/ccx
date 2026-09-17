// Finding an instance's window and putting it in front of you.

import {BYTES, MAC, ON_EXIT, sh, shSync} from "./sh.js";
import {kittyOwner, processes} from "./claudes.js";

// `kitten @` writes a bare `ESC P @kitty-cmd {...} ESC \`, and tmux forwards only
// `ESC P tmux; ... ESC \`, so the command never reaches kitty and --no-response still
// exits 0. Hence building the sequence here and wrapping it.
const KITTY_RC_VERSION = [0, 26, 0];

// Send one kitty remote-control command. With a `tty` the bare sequence goes straight
// there, the only path that works with no controlling terminal of our own; without one it
// falls back to /dev/tty, wrapped for tmux, which swallows a bare DCS.
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
    // create/truncate are no-ops on a tty, which is what every real target is
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

// The niri window id for a process, or null. A kitty process owns exactly one OS window,
// so its pid identifies the window; `single_instance` or `kitty @ launch --type=os-window`
// would break that and raise whichever of them niri lists first.
async function niriWindow(pid) {
  try {
    for (const w of JSON.parse(await sh("niri", "msg", "--json", "windows") || "[]")) {
      if (String(w.pid) === String(pid)) return w.id;
    }
  } catch {
    return null;
  }
  return null;
}

// Bring the terminal's own window to the front. On Wayland an app cannot raise itself
// without a recent interaction, so the compositor is asked by its own window id.
async function raiseWindow(inst) {
  if (MAC) {
    await sh("open", "-a", "kitty");
    return;
  }
  if (!inst.kittyProc) return;
  const wid = await niriWindow(inst.kittyProc);
  if (wid !== null) await sh("niri", "msg", "action", "focus-window", "--id", String(wid));
}

// What raiseWindow() would do with this instance, for `ccx doctor` to print.
export async function raiseTarget(inst) {
  if (MAC) return "open -a kitty";
  if (!inst.kittyProc) return "(no kitty ancestor)";
  const wid = await niriWindow(inst.kittyProc);
  return wid !== null ? `niri ${wid}` : `(kitty ${inst.kittyProc} not in niri)`;
}

// Focus the instance. Returns an error message, or null when it worked.
export async function jump(inst) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to focus`;
  // one tmux call: the three must land in this order, and `;` says so in one process
  const client = inst.clientTty
    ? ["switch-client", "-c", inst.clientTty, "-t", inst.session, ";"]
    : Deno.env.get("TMUX") ? ["switch-client", "-t", inst.session, ";"] : [];
  await sh("tmux", ...client,
    "select-window", "-t", `${inst.session}:${inst.window}`, ";",
    "select-pane", "-t", inst.pane);
  if (inst.match) {
    // the client's own tty, so this works with no controlling terminal of our own
    sendKitty("focus-window", {match: inst.match}, inst.clientTty || null);
  }
  await raiseWindow(inst);
  return null;
}

// Name our own tmux window for as long as the app runs. Returns the restore.
// automatic-rename otherwise shows the pane's foreground command, `deno`. `allow-rename`
// is off by default, so ESC k is ignored and only `rename-window` works; that turns
// automatic-rename off for the window, hence the restore.
export function tmuxWindowName(name) {
  const pane = Deno.env.get("TMUX_PANE");
  if (!pane) return () => {};
  // shSync, not sh: the restore runs from ON_EXIT, and Deno.exit does not await a promise
  const was = shSync("tmux", "display-message", "-p", "-t", pane,
    "#{automatic-rename}\t#{window_name}").trim();
  shSync("tmux", "rename-window", "-t", pane, name);

  const restore = () => {
    const [auto, before] = [was.slice(0, was.indexOf("\t")), was.slice(was.indexOf("\t") + 1)];
    if (auto === "1" || !before) {
      shSync("tmux", "set-window-option", "-t", pane, "automatic-rename", "on");
    } else {
      shSync("tmux", "rename-window", "-t", pane, before);
    }
  };
  ON_EXIT.push(restore);
  return () => {
    ON_EXIT.splice(ON_EXIT.indexOf(restore), 1);
    restore();
  };
}

// Name our own kitty window for as long as the app runs. Target the client's kitty
// ancestor, never KITTY_WINDOW_ID: inside a pane that is inherited from the tmux SERVER's
// environment and can name a window that closed long ago.
export async function kittyWindowTitle(name) {
  let target = {};
  if (Deno.env.get("TMUX")) {
    const pid = (await sh("tmux", "display-message", "-p", "#{client_pid}")).trim();
    if (!pid) return () => {};        // no client attached, so no window to name
    target = {match: `pid:${kittyOwner(Number(pid), await processes())[0]}`};
  }
  sendKitty("set-window-title", {...target, title: name});

  const restore = () => sendKitty("set-window-title", target);  // no title: kitty's default
  ON_EXIT.push(restore);
  return () => {
    ON_EXIT.splice(ON_EXIT.indexOf(restore), 1);
    restore();
  };
}
