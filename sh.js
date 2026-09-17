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
  try {
    const r = await new Deno.Command(args[0], {args: args.slice(1), stdin: "null",
      signal: AbortSignal.timeout(TIMEOUT)}).output();
    return r.code === 0 ? UTF8.decode(r.stdout) : "";
  } catch {
    return "";
  }
}

// Synchronous and untimed, for the ON_EXIT path ONLY: Deno.exit does not wait for a
// promise, so an exit handler that awaited would die before its tmux command ran. Nothing
// in the poll loop may use this, since outputSync has no timeout.
export function shSync(...args) {
  try {
    const r = new Deno.Command(args[0], {args: args.slice(1), stdin: "null"}).outputSync();
    return r.code === 0 ? UTF8.decode(r.stdout) : "";
  } catch {
    return "";
  }
}

// Deno.exit skips every finally, so whatever must run before the process dies goes here.
export const ON_EXIT = [];
