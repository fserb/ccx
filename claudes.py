"""Every running Claude Code instance, and how to focus one.

No UI here: discover() is the listing (path, state, summary, how long it has been in
that state, and the tmux/kitty coordinates), jump() is the action. Only stdlib, so it
imports into anything.

Mapping chain, verified on this setup:

    claude pid --(walk ppid)--> tmux pane_pid --> session --> client_pid
              --(walk ppid)--> kitty's direct child --> kitty window

kitty matches a window only by its *direct* child pid. `zsh -l -c tmux` execs tmux and
the client is that child, but ktmux (kitty.conf's `shell`) keeps its wrapper zsh alive
between kitty and the client, so the client pid has to be walked up to the ancestor
whose parent is kitty before `match pid:N` finds the window.
"""

import contextlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass

HOME = os.path.expanduser("~")

# ------------------------------------------------------------------ the listing

def sh(*args, timeout=4):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


@dataclass
class Instance:
    pid: int
    pane: str = ""
    session: str = ""
    window: str = ""
    pane_index: str = ""
    tab: str = ""            # window index, only when the session holds >1 claude
    path: str = ""
    summary: str = ""
    state: str = ""          # "" until StateClock fills it in
    status_since: float = 0  # epoch of the record's last status change, 0 without one
    last_write: float = 0    # epoch claude last wrote to its session log
    since: float = 0.0       # epoch this instance entered its current state
    client_tty: str = ""
    kitty_pid: str = ""      # kitty's own child above the tmux client; what `pid:` matches

    @property
    def match(self):
        return f"pid:{self.kitty_pid}" if self.kitty_pid else None

    @property
    def short_path(self):
        path = self.path.replace(HOME, "~") if self.path else "?"
        return f"{path}:{self.tab}" if self.tab else path

    @property
    def age(self):
        return fmt_age(time.time() - self.since) if self.since else "?"


def fmt_age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    return f"{seconds // 3600}h"


SESSIONS = f"{HOME}/.claude/sessions"


def project_dir(cwd):
    """Where claude keeps the session logs for a cwd: the path, non-alphanumerics to -."""
    return f"{HOME}/.claude/projects/{re.sub(r'[^A-Za-z0-9]', '-', cwd)}"


def last_write(path):
    """When claude last wrote a message for this cwd, from its session log's mtime.

    tmux's `window_activity` looks like the obvious source and is useless: Claude's TUI
    repaints constantly, so an idle pane still reports activity ~now. The session log is
    only appended on real messages.
    """
    try:
        entries = os.scandir(project_dir(path))
        return max(e.stat().st_mtime for e in entries if e.name.endswith(".jsonl"))
    except (OSError, ValueError):
        return 0


# what Claude Code calls itself, in ~/.claude/sessions/<pid>.json, mapped onto our three.
# "waiting" is a dialog holding the screen (a permission prompt, /model, an elicitation)
# and "shell" is idle with a background shell still running; both want you, like "idle"
RECORD_STATE = {"busy": "busy", "waiting": "wait", "idle": "wait", "shell": "wait"}
BIG_LOG = 256 * 1024


def session_records():
    """Claude Code's own view of every live session, keyed by pid.

    It writes ~/.claude/sessions/<pid>.json for each interactive session and rewrites it
    on every status change, so `status` is the state as the process itself knows it, not
    as the screen looks: "busy" is a turn in flight *including the final message
    streaming out*, which is the one the screen cannot see. Reading it is what keeps a
    session that is still writing its answer from being called wait (verified live: the
    scrape called two sessions wait while they were retrying an API error, and the
    records said busy). Checked against Claude Code v2.1.252; a version that stops
    writing these files falls back to pane_state().
    """
    try:
        entries = os.scandir(SESSIONS)
    except OSError:
        return {}
    records = {}
    for e in entries:
        pid, _, ext = e.name.partition(".")
        if ext != "json" or not pid.isdigit():
            continue
        try:
            with open(e.path) as f:
                records[int(pid)] = json.load(f)
        except (OSError, ValueError):
            continue
    return records


def record_state(rec):
    """(state, epoch it started), or ("", 0) when this pid has no record.

    A session with nothing in it is free, except when a dialog is up: that one is asking
    you something, empty or not, which is what an unanswered trust prompt is.
    """
    state = RECORD_STATE.get(rec.get("status"), "")
    if not state:
        return "", 0
    if (state == "wait" and rec.get("status") != "waiting"
            and not has_reply(rec.get("cwd", ""), rec.get("sessionId", ""))):
        state = "free"
    return state, (rec.get("statusUpdatedAt") or 0) / 1000


def has_reply(cwd, session_id):
    """Whether this session ever got an answer, which is what free is not.

    /clear starts a *new* sessionId, and a fresh one's log holds a handful of bookkeeping
    lines (~2.6KB) with no assistant entry, so this reads the same as a session that has
    never been asked anything. Any log past BIG_LOG is a real conversation, which keeps
    the read small; the log for a session that has said nothing yet does not exist.
    """
    path = f"{project_dir(cwd)}/{session_id}.jsonl"
    try:
        if os.path.getsize(path) > BIG_LOG:
            return True
        with open(path, "rb") as f:
            return b'"type":"assistant"' in f.read()
    except OSError:
        return False


# the last title line was never further than 34KB from the end of the log, over the 108
# logs on this machine that carry one, so a tail this size finds it with room to spare
TITLE_TAIL = 256 * 1024
TITLES = {}              # session log -> (size when read, title found)


def session_title(cwd, session_id):
    """Claude's own name for the session, from the transcript.

    Claude Code generates this once per conversation, from the first real user prompt,
    with a separate model call, then appends it to the log as an "ai-title" line and puts
    it in the terminal title. /rename writes a "custom-title" line, which outranks it in
    the terminal title and here. It is a name for the session, not a live task summary:
    it does not follow the work as it moves on.

    The log beats pane_title (the terminal title as tmux saw it) on three counts: no
    glyph to strip, no tmux needed, and it is never stale after /clear, since /clear
    starts a new sessionId whose log carries no title until one is generated while
    pane_title keeps the old text for ~a minute.

    The line is re-appended on every prompt, so the last one in the tail is current. The
    read is cached against the log's size and redone whenever the log has grown, which is
    what carries a /rename or a first title onto the next poll; a log that has not been
    written to since the last poll costs one stat. Six logs, all missing, all re-read,
    measured at 1.8ms against discover()'s ~50ms.
    """
    if not (cwd and session_id):
        return ""
    path = f"{project_dir(cwd)}/{session_id}.jsonl"
    try:
        size = os.path.getsize(path)
    except OSError:
        return ""
    size_read, title = TITLES.get(path, (-1, ""))
    if size == size_read:
        return title
    title = read_title(path, size)
    TITLES[path] = (size, title)
    return title


def read_title(path, size):
    """The last title in the tail of a session log, /rename's winning over the AI one."""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, size - TITLE_TAIL))
            lines = f.read().splitlines()
    except OSError:
        return ""
    found = {}
    for line in lines:
        if b'"type":"ai-title"' not in line and b'"type":"custom-title"' not in line:
            continue
        try:                                  # the first line of the tail is a fragment
            rec = json.loads(line)
        except ValueError:
            continue
        found[rec.get("type")] = rec.get("customTitle") or rec.get("aiTitle") or ""
    return found.get("custom-title") or found.get("ai-title") or ""


class StateClock:
    """When each instance entered its current state, and which ones just changed.

    The record's statusUpdatedAt is the transition itself, so it beats both the poll it
    was noticed in and the session-log mtime, which is only the seed left for instances
    with no record. A displayed state that spans two of Claude's own (idle and shell are
    both wait) keeps the earlier time, since the row did not change.
    """

    def __init__(self):
        self.seen = {}
        self.woke = []       # instances that went busy -> wait during the last update

    def update(self, instances):
        now = time.time()
        self.woke = []
        for i in instances:
            state, since = self.seen.get(i.pid, (None, None))
            # a screen we could not read is not a transition: an empty capture-pane, or a
            # tmux hiccup that drops every pane, would otherwise read as wait and ring for
            # every running instance at once
            i.state = i.state or state or "wait"
            if state is None:                       # first sight
                i.since = i.status_since or i.last_write or now
            elif state == i.state:
                i.since = since
            else:
                i.since = i.status_since or now
            # only busy -> wait rings, which is a turn ending or a prompt appearing. first
            # sight is not a transition, so starting up is silent however many are waiting
            if state == "busy" and i.state == "wait":
                self.woke.append(i)
            self.seen[i.pid] = (i.state, i.since)
        live = {i.pid for i in instances}
        self.seen = {pid: v for pid, v in self.seen.items() if pid in live}
        return instances


IS_CLAUDE = re.compile(r"(^|/)claude(\s|$)|\.claude/local/.*cli\.js")
PS_LINE = re.compile(r"\s*(\d+)\s+(\d+)\s+(.*)")


def processes():
    table = {}
    for line in sh("ps", "-axo", "pid=,ppid=,command=").splitlines():
        if m := PS_LINE.match(line):
            table[int(m[1])] = (int(m[2]), m[3])
    return table


def kitty_child(pid, procs):
    """The ancestor of a tmux client that `match pid:` will actually find.

    kitty matches a window only by its *direct* child pid. `zsh -l -c tmux` execs tmux
    and the client is that child, but under ktmux (kitty.conf's `shell`) the wrapper zsh
    stays alive between kitty and the client, and `pid:<client_pid>` matched nothing,
    silently: the jump switched panes and moved no window, for every window ktmux had
    opened. A client with no kitty ancestor (ssh, another terminal) comes back unchanged,
    which fails the same way it always did.
    """
    cur = pid
    for _ in range(12):
        ppid, _ = procs.get(cur, (0, ""))
        if ppid not in procs:
            return pid
        if procs[ppid][1].split(" ")[0].rpartition("/")[2] == "kitty":
            return cur
        cur = ppid
    return pid


def tmux_rows(subcommand, fields, *extra):
    fmt = "\t".join(f"#{{{f}}}" for f in fields)
    out = sh("tmux", subcommand, *extra, "-F", fmt)
    return [dict(zip(fields, line.split("\t"))) for line in out.splitlines() if line]


def capture(pane, lines=40):
    return sh("tmux", "capture-pane", "-p", "-t", pane, "-S", f"-{lines}")


# the spinner line, "✽ Working… (16m 29s · ↓ 54.6k tokens)". The parenthetical is drawn
# a moment after the label, so ~3% of captures during a turn (measured) catch a bare
# "✽ Beboppin'…" and requiring it read those frames as wait. Anchor on the cycling glyph
# instead, which also keeps "⏺ Calling chrome-devtools 5 times…" (tool output, not the
# spinner) out.
SPINNER = re.compile(r"^\s*[·✢✳✶✻✽*]\s+\S.*…")
BANNER = re.compile(r"Claude Code v\d")   # the startup banner, which /clear repaints


def pane_state(text):
    """busy (a turn is running), free (nothing in the session), or wait (yours).

    Read the bottom of the screen, never the whole capture: a marker matched anywhere in
    the scrollback misreads a session that merely *discusses* it, and the pane talking
    about these very patterns did exactly that. `esc to interrupt` also looks like the
    busy marker and is not, since the bottom hint line still reads that way in a pane
    that has been sitting untouched for minutes. The spinner is only drawn while a turn
    actually runs, and it sits just above the prompt box.

    A session with no conversation shows the startup banner with nothing under it, and
    /clear repaints that banner, so walking up from the bottom and reaching the banner
    before any assistant marker means the session is empty. Everything else wants you,
    whether it holds a permission prompt or just finished its task.
    """
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return ""            # nothing was read; the caller keeps the previous state
    if any(SPINNER.search(l) for l in lines[-8:]):
        return "busy"
    for line in reversed(lines):
        if "⏺" in line:
            break
        if BANNER.search(line):
            return "free"
    return "wait"


def summary_of(title):
    """The session title as pane_title has it, for instances with no record to read.

    "Claude Code" is the literal default the title falls back to before a session has a
    title of its own, not a title. The leading glyph is Claude's, and under tmux it is
    always the same one: it detects the multiplexer and stops animating it.
    """
    text = title.lstrip("✳✶✻✽* ·").strip()
    return "" if text == "Claude Code" else text


def discover():
    procs = processes()
    records = session_records()
    panes = tmux_rows("list-panes", ["session_name", "window_index", "pane_index", "pane_id",
                                     "pane_pid", "pane_current_path", "pane_title"], "-a")
    clients = tmux_rows("list-clients", ["client_tty", "client_pid", "client_session"])
    pane_by_pid = {int(p["pane_pid"]): p for p in panes}
    client_by_session = {c["client_session"]: c for c in clients}

    found = []
    for pid, (_, cmd) in procs.items():
        if not IS_CLAUDE.search(cmd):
            continue
        rec = records.get(pid, {})
        state, since = record_state(rec)
        pane, cur = None, pid
        for _ in range(12):                      # walk up to the owning pane
            if cur in pane_by_pid:
                pane = pane_by_pid[cur]
                break
            if cur not in procs:
                break
            cur = procs[cur][0]
        title = session_title(rec.get("cwd", ""), rec.get("sessionId", ""))
        if not pane:
            # nothing to focus without a pane, but the record still knows the rest
            found.append(Instance(pid=pid, summary=title or cmd, path=rec.get("cwd", ""),
                                  state=state, status_since=since))
            continue
        client = client_by_session.get(pane["session_name"], {})
        cpid = client.get("client_pid", "")
        found.append(Instance(
            pid=pid,
            pane=pane["pane_id"],
            session=pane["session_name"],
            window=pane["window_index"],
            pane_index=pane["pane_index"],
            path=pane["pane_current_path"],
            # the transcript is the whole answer once there is a record: it names the
            # session claude is in *now*, where pane_title still shows the one before a
            # /clear. pane_title is what is left when there is no record, as with state
            summary=title if rec else summary_of(pane["pane_title"]),
            state=state or pane_state(capture(pane["pane_id"])),
            status_since=since,
            last_write=0 if state else last_write(pane["pane_current_path"]),
            client_tty=client.get("client_tty", ""),
            kitty_pid=str(kitty_child(int(cpid), procs)) if cpid else "",
        ))
    tag_tabs(found)
    return sorted(found, key=lambda i: (i.short_path, i.pid))


def tag_tabs(found):
    """Tab suffix for the path, but only where it disambiguates.

    One kitty window shows one tmux window at a time, so the tab number only matters when
    a session holds more than one claude. Two in the same window get `:N.M` with the pane.
    """
    for i in found:
        peers = [p for p in found if p.session and p.session == i.session]
        if len(peers) < 2:
            continue
        same_window = [p for p in peers if p.window == i.window]
        i.tab = f"{i.window}.{i.pane_index}" if len(same_window) > 1 else i.window


# ----------------------------------------------------------------- the jump

# `kitten @` writes a bare `ESC P @kitty-cmd {...} ESC \` to the tty. tmux forwards only
# `ESC P tmux; ... ESC \`, so the bare form is swallowed and the command never reaches
# kitty (silently, with --no-response). So build the sequence here and wrap it.
KITTY_RC_VERSION = [0, 26, 0]


def send_kitty(command, payload, tty=None):
    """Send one kitty remote-control command. `tty` picks which of two paths it takes.

    A tmux client's tty *is* the pty kitty gave that window, with the client on the other
    end, so bytes written to it reach kitty directly and the tmux passthrough wrapper is
    neither needed nor wanted. That path also works from a process with no controlling
    terminal at all, which is what a menu-bar app is: open("/dev/tty") there fails with
    ENXIO, so it is the only path that works from one. Verified live from a setsid child:
    a bare DCS written to another window's client tty focused that window.

    Without a tty it falls back to our own /dev/tty, wrapped for tmux when we are inside
    it. Both carry an explicit `match`, so either one can drive any window: one kitty
    process owns every window here (verified: both windows' kitty_child sits under the
    same kitty pid), and the command names its target rather than inferring it.
    """
    msg = {"cmd": command, "version": KITTY_RC_VERSION, "no_response": True,
           "payload": payload}
    if wid := os.environ.get("KITTY_WINDOW_ID"):
        msg["kitty_window_id"] = int(wid)
    seq = f"\x1bP@kitty-cmd{json.dumps(msg, separators=(',', ':'))}\x1b\\"
    if not tty and os.environ.get("TMUX"):
        seq = f"\x1bPtmux;{seq.replace(chr(27), chr(27) * 2)}\x1b\\"
    target = tty or "/dev/tty"
    try:
        with open(target, "w") as out:
            out.write(seq)
            out.flush()
        return True
    except OSError as e:
        print(f"cannot write to {target}: {e}", file=sys.stderr)
        return False


def jump(inst):
    """Focus the instance. Returns an error message, or None when it worked."""
    if not inst.pane:
        return f"pid {inst.pid} is not inside tmux; nothing to focus"
    if inst.client_tty:
        sh("tmux", "switch-client", "-c", inst.client_tty, "-t", inst.session)
    elif os.environ.get("TMUX"):
        sh("tmux", "switch-client", "-t", inst.session)
    sh("tmux", "select-window", "-t", f"{inst.session}:{inst.window}")
    sh("tmux", "select-pane", "-t", inst.pane)
    if inst.match:
        # the client's own tty, so this works with no controlling terminal of our own
        send_kitty("focus-window", {"match": inst.match}, tty=inst.client_tty or None)
    if sys.platform == "darwin":
        sh("open", "-a", "kitty")
    return None


# quitting calls os._exit (see App.action_quit), which skips every `finally`, so anything
# that has to run before the process dies registers itself here
ON_EXIT = []


@contextlib.contextmanager
def tmux_window_name(name):
    """Name our own tmux window for as long as the app runs.

    tmux's automatic-rename uses the pane's foreground command, and the `uv run --script`
    shebang keeps uv as that process, so the tab reads `uv`. `allow-rename` is off by
    default, so the ESC k escape is ignored and only `rename-window` works; it also turns
    automatic-rename off for the window, hence the restore.
    """
    pane = os.environ.get("TMUX_PANE")
    if not pane:
        yield
        return
    was = sh("tmux", "display-message", "-p", "-t", pane,
             "#{automatic-rename}\t#{window_name}").strip()
    sh("tmux", "rename-window", "-t", pane, name)

    def restore():
        auto, _, before = was.partition("\t")
        if auto == "1" or not before:
            sh("tmux", "set-window-option", "-t", pane, "automatic-rename", "on")
        else:
            sh("tmux", "rename-window", "-t", pane, before)

    ON_EXIT.append(restore)
    try:
        yield
    finally:
        ON_EXIT.remove(restore)
        restore()


@contextlib.contextmanager
def kitty_window_title(name):
    """Name our own kitty window (what the tab bar shows) for as long as the app runs.

    tmux ships with `set-titles off`, so nothing inside a pane ever writes a title and
    kitty falls back to its own default, the foreground process, which reads `uv` for the
    same reason the tmux tab does. Setting it without `temporary` makes it permanent, so
    it also survives a config with `set-titles on`; sending the command with no title at
    all is what puts kitty's default back.

    Target the window by the client's kitty_child(), the same `pid:N` match jump() uses.
    KITTY_WINDOW_ID cannot be trusted here: inside a pane it is inherited from the
    environment the tmux *server* started in, so it can name a window that closed long
    ago.
    """
    target = {}
    if os.environ.get("TMUX"):
        pid = sh("tmux", "display-message", "-p", "#{client_pid}").strip()
        if not pid:                          # no client attached, so no window to name
            yield
            return
        target = {"match": f"pid:{kitty_child(int(pid), processes())}"}
    send_kitty("set-window-title", target | {"title": name})

    def restore():
        send_kitty("set-window-title", target)     # no title: back to kitty's default

    ON_EXIT.append(restore)
    try:
        yield
    finally:
        ON_EXIT.remove(restore)
        restore()
