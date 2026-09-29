// Running a command, and the two or three constants every other file here needs.
export const HOME = Deno.env.get("HOME") ?? "";
export const MAC = Deno.build.os === "darwin";

export const UTF8 = new TextDecoder();
// Code point order. localeCompare collates instead, which orders case and punctuation
// differently.
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const BYTES = new TextEncoder();

// Run a command, or "" if it fails. Every caller shares a task with the input loop, so a
// tmux that never returns would hang the UI. AbortSignal SIGTERMs the child, which arrives
// as exit 143 and so needs no branch of its own (measured: 307ms for a 300ms signal).
const TIMEOUT = 4000;
export async function sh(...args) {
  const r = await run(...args);
  return r.code === 0 ? r.out : "";
}

// tmux decides UTF-8 from LANG/LC_*, and the launchd plist sets neither, so under the
// systray it printed every tab in a -F format as `_` and no pane was ever found. -u forces
// it; it also keeps the glyphs capture-pane and pane_title are read for.
const argv = (args) => args[0] === "tmux" ? ["-u", ...args.slice(1)] : args.slice(1);

// sh() with the exit code and stderr, for a caller that has to say why it failed. -1 is a
// command that could not start.
export async function run(...args) {
  try {
    const r = await new Deno.Command(args[0], {args: argv(args), stdin: "null",
      signal: AbortSignal.timeout(TIMEOUT)}).output();
    return {code: r.code, out: UTF8.decode(r.stdout), err: UTF8.decode(r.stderr)};
  } catch (e) {
    return {code: -1, out: "", err: e.message};
  }
}

// Synchronous and untimed, for the ON_EXIT path ONLY: Deno.exit does not wait for a
// promise, so an exit handler that awaited would die before its tmux command ran. Nothing
// in the poll loop may use this, since outputSync has no timeout.
export function shSync(...args) {
  try {
    const r = new Deno.Command(args[0], {args: argv(args), stdin: "null"}).outputSync();
    return r.code === 0 ? UTF8.decode(r.stdout) : "";
  } catch {
    return "";
  }
}

// Deno.exit skips every finally, so whatever must run before the process dies goes here.
export const ON_EXIT = [];
