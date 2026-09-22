// Whether the API the instances talk to is answering, and which one that is. No UI and no
// timer of its own: both front ends call tick() from the poll they already run and read
// `offline` when they draw.

import {HOME} from "./sh.js";

const DEFAULT = "https://api.anthropic.com";
const MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";
const USER = `${HOME}/.claude/settings.json`;
const VAR = "ANTHROPIC_BASE_URL";
const PATH = "/v1/models";  // 401 unauthenticated, which is an answer; `/` gives 404

const UP_GAP = 30_000;      // between probes while it answers
const DOWN_GAP = 5_000;     // and once one has failed, so a recovery shows promptly
const TIMEOUT = 8_000;      // against a 1.7-2.0s round trip to api.anthropic.com, measured
const STRIKES = 2;          // consecutive failures before anything draws it; one clears it

// `env.ANTHROPIC_BASE_URL` out of a settings file, or "". Anything unreadable, unparseable
// or half-written reads as unset: this runs on a timer against a file claude also writes.
export function baseFromSettings(path) {
  try {
    const url = JSON.parse(Deno.readTextFileSync(path))?.env?.[VAR];
    return typeof url === "string" ? url.trim() : "";
  } catch {
    return "";
  }
}

// Which source wins, given what each one holds. Split out from apiBase() because it is the
// half worth testing and the other half reads two fixed paths.
//
// PER-PROJECT `.claude/settings.json` IS NOT READ. One icon cannot stand for seven
// instances pointed at different proxies, so this is the machine's endpoint and not any
// one instance's; an instance overriding it in its own project is not noticed.
export function pickBase(managed, user, env) {
  const pick = [[managed, MANAGED], [user, "~/.claude/settings.json"], [env, `$${VAR}`]]
    .find(([url]) => url);
  if (!pick) return {url: DEFAULT, from: "default"};
  return {url: pick[0].replace(/\/+$/, ""), from: pick[1]};
}

// The endpoint claude would talk to on this machine, and the name of whatever set it.
//
// The order is claude's own: a managed policy outranks the user's settings, which outrank
// the environment. THE ENVIRONMENT IS THE ONE THE TRAY CANNOT SEE: `./task install` hands
// the app a plist holding PATH and HOME and nothing else, so a var exported in a shell
// reaches `ccx` and never reaches `ccx systray`. A settings file reaches both.
export function apiBase() {
  return pickBase(baseFromSettings(MANAGED), baseFromSettings(USER),
    (Deno.env.get(VAR) ?? "").trim());
}

export class Online {
  constructor(base = apiBase()) {
    this.url = base.url;
    this.from = base.from;
    this.fails = 0;          // consecutive failed probes, capped at STRIKES
    this.last = 0;           // performance.now() the last probe returned; 0 = never probed
    this.busy = false;
    this.note = "";          // what that probe answered, for doctor
  }

  // What the UIs draw. Starting at zero strikes is deliberate: nothing is slashed while
  // the first probe is still in flight, which is every start.
  get offline() {
    return this.fails >= STRIKES;
  }

  // What a UI writes. THE HOST IS NAMED ONLY WHEN IT IS NOT THE DEFAULT: that it is not
  // Anthropic is the whole of what an override adds, and on a 100-cell terminal the 30
  // cells of `offline api.anthropic.com  ·  ` cost the bar its key hints entirely.
  get label() {
    return this.url === DEFAULT ? "offline" : `offline ${this.host}`;
  }

  get host() {
    try {
      return new URL(this.url).host;
    } catch {
      return this.url;
    }
  }

  due(now = performance.now()) {
    if (this.busy) return false;
    return !this.last || now - this.last >= (this.fails ? DOWN_GAP : UP_GAP);
  }

  record(ok, note = "") {
    this.fails = ok ? 0 : Math.min(this.fails + 1, STRIKES);
    this.note = note;
  }

  // One request. Down is NO HTTP ANSWER AT ALL or a 5xx: a 401 or a 404 proves the server
  // is there, which is all this asks. The body is cancelled rather than read, or the
  // connection is held open until it is collected.
  async probe() {
    const at = performance.now();
    try {
      const r = await fetch(`${this.url}${PATH}`, {signal: AbortSignal.timeout(TIMEOUT)});
      await r.body?.cancel();
      return {ok: r.status < 500, note: `HTTP ${r.status}`, ms: performance.now() - at};
    } catch (e) {
      return {ok: false, note: `${e.name}: ${e.message}`, ms: performance.now() - at};
    }
  }

  // Called from a poll that must not wait for a network round trip, so nothing here is
  // awaited and a probe outliving several ticks is what `busy` is for.
  tick() {
    if (!this.due()) return;
    this.busy = true;
    this.probe().then((r) => this.record(r.ok, r.note)).finally(() => {
      this.busy = false;
      this.last = performance.now();
    });
  }
}
