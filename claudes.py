"""Every running Claude Code instance, and how to focus one.

No UI here: discover() is the listing (path, state, summary, how long it has been in
that state, and the tmux/kitty coordinates), jump() is the action. Only stdlib, so it
imports into anything.

Mapping chain, verified on macOS and on Linux/niri:

    claude pid --(walk ppid)--> tmux pane_pid --> session --> client_pid
              --(walk ppid)--> kitty's direct child --> kitty window
                          --> kitty itself --> the compositor's window id

kitty matches a window only by its *direct* child pid. `zsh -l -c tmux` execs tmux and
the client is that child, but ktmux (kitty.conf's `shell`) keeps its wrapper zsh alive
between kitty and the client, so the client pid has to be walked up to the ancestor
whose parent is kitty before `match pid:N` finds the window.

Almost none of this is per-platform. `ps -axo` takes the same flags either way, and
kitty's remote control arrives the same way through tmux's passthrough (verified on niri:
a bare DCS written to another window's client tty renamed that window). Two things do
differ, and they are the whole of the per-platform code here: what plays the bell, and
how the terminal window itself gets raised. See PLAYERS and raise_window().
"""

import base64
import contextlib
import ctypes
import ctypes.util
import io
import json
import lzma
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from array import array
from dataclasses import dataclass
from itertools import accumulate

HOME = os.path.expanduser("~")
MAC = sys.platform == "darwin"
VOID = ctypes.c_void_p

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
    kitty_proc: str = ""     # kitty itself; what a Wayland compositor knows the window by

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


# a UI rings this on StateClock.woke; the library itself never makes a sound.
#
# The sound is BOTTLE, at the bottom of this file, so the bell is the same one on both
# platforms: freedesktop's complete.oga, the old Linux default, ships with a sound theme
# and not with a base install. Nothing here writes a file. macOS plays the bytes through
# AVAudioPlayer (see ring()), Linux pipes them to a player's stdin, and each argv ends in
# how that player spells stdin: `paplay -` opens a file named `-` and fails, so paplay
# gets nothing. In order of how little they do; ffplay decodes it itself.
if MAC:
    PLAYERS = []
else:
    PLAYERS = [["pw-play", "-"], ["paplay"],
               ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-"]]
PLAYER = None            # resolved on the first ring, then reused
PLAYING = []
BELL = None              # BOTTLE unpacked, on the first ring
RINGER = None            # the AVAudioPlayer holding it, on the first ring; macOS only
OBJC = None              # (send, class, selector), once libobjc is loaded


def bell():
    """The player argv, resolved once: the first of PLAYERS that is installed, or []."""
    global PLAYER
    if PLAYER is None:
        PLAYER = next((p for p in PLAYERS if shutil.which(p[0])), [])
    return PLAYER


def ringer():
    """What will make the sound, for doctor."""
    return "AVAudioPlayer" if MAC else " ".join(bell()) or "(no player)"


def sound():
    """BOTTLE unpacked into the bytes of a WAV file, once."""
    global BELL
    if BELL is None:
        deltas = array("h")
        deltas.frombytes(lzma.decompress(base64.b64decode(BOTTLE)))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(array("h", accumulate(accumulate(deltas))).tobytes())
        BELL = buf.getvalue()
    return BELL


def ring(wav):
    """Play wav through AVAudioPlayer, which takes bytes and wants no file. macOS.

    No macOS player reads stdin: afplay opens through AudioFile, which seeks, so a pipe
    and a fifo both die with AudioFileOpen failed. ctypes and not PyObjC because this
    file is stdlib-only. Built once (~120ms) and rewound per ring (0.12ms).

    The stop is not optional. Once the sound has run out, play on its own returns YES and
    does nothing, with isPlaying false and currentTime stuck at 0 (measured);
    prepareToPlay does not help. It also makes a ring during a ring retrigger.

    alloc/init throughout: the class constructors autorelease, and a process with no
    Cocoa loop has no pool to drain, which the runtime complains about on stderr, i.e.
    onto the TUI. Nothing is released, so the player outlives the ring on purpose.
    """
    global OBJC, RINGER
    if OBJC is None:
        objc = ctypes.CDLL(ctypes.util.find_library("objc"))
        ctypes.CDLL("/System/Library/Frameworks/AVFoundation.framework/AVFoundation")
        objc.objc_getClass.restype = objc.sel_registerName.restype = ctypes.c_void_p
        at = ctypes.cast(objc.objc_msgSend, ctypes.c_void_p).value
        # a prototype per signature: on arm64 a variadic call passes arguments
        # differently, so objc_msgSend cannot be called untyped
        OBJC = (lambda ret, *args: ctypes.CFUNCTYPE(ret, VOID, VOID, *args)(at),
                lambda name: VOID(objc.objc_getClass(name.encode())),
                lambda name: VOID(objc.sel_registerName(name.encode())))
    send, cls, sel = OBJC
    if RINGER is None:
        data = VOID(send(VOID, ctypes.c_char_p, ctypes.c_size_t)(
            VOID(send(VOID)(cls("NSData"), sel("alloc"))),
            sel("initWithBytes:length:"), wav, len(wav)))
        RINGER = VOID(send(VOID, VOID, VOID)(
            VOID(send(VOID)(cls("AVAudioPlayer"), sel("alloc"))),
            sel("initWithData:error:"), data, None))
        if not RINGER.value:
            return
        send(ctypes.c_bool)(RINGER, sel("prepareToPlay"))
    send(ctypes.c_bool)(RINGER, sel("stop"))
    send(None, ctypes.c_double)(RINGER, sel("setCurrentTime:"), 0.0)
    send(ctypes.c_bool)(RINGER, sel("play"))


def play():
    """Ring the bell and return immediately.

    The WAV is 17684 bytes, under the 64KB a pipe holds, so the write cannot block on a
    player that is slow to start. The player runs 0.4s and reload() calls this on the UI
    thread every 1.5s, so it is never waited on; an unwaited child is a zombie until the
    poll above collects it, and SIGCHLD cannot be ignored instead because sh() needs its
    own children reapable. No player installed is no sound.
    """
    if MAC:
        with contextlib.suppress(OSError):
            ring(sound())
        return
    PLAYING[:] = [p for p in PLAYING if p.poll() is None]
    if not (cmd := bell()):
        return
    with contextlib.suppress(OSError):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        PLAYING.append(p)
        with p.stdin as pipe:      # closed even if a player that died mid-write breaks it
            pipe.write(sound())


IS_CLAUDE = re.compile(r"(^|/)claude(\s|$)|\.claude/local/.*cli\.js")
PS_LINE = re.compile(r"\s*(\d+)\s+(\d+)\s+(.*)")


def processes():
    table = {}
    for line in sh("ps", "-axo", "pid=,ppid=,command=").splitlines():
        if m := PS_LINE.match(line):
            table[int(m[1])] = (int(m[2]), m[3])
    return table


def kitty_owner(pid, procs):
    """(the ancestor of a tmux client `match pid:` will find, kitty's own pid).

    kitty matches a window only by its *direct* child pid. `zsh -l -c tmux` execs tmux
    and the client is that child, but under ktmux (kitty.conf's `shell`) the wrapper zsh
    stays alive between kitty and the client, and `pid:<client_pid>` matched nothing,
    silently: the jump switched panes and moved no window, for every window ktmux had
    opened. So walk up until the parent is kitty rather than assuming either shape; the
    Linux setup runs the same kitty.conf and there the client *is* the direct child.

    The second value is kitty itself, which raise_window() needs on Wayland and nothing
    needs on macOS. A client with no kitty ancestor (ssh, another terminal) comes back
    unchanged and with 0, which fails the same way it always did.
    """
    cur = pid
    for _ in range(12):
        ppid, _ = procs.get(cur, (0, ""))
        if ppid not in procs:
            break
        if procs[ppid][1].split(" ")[0].rpartition("/")[2] == "kitty":
            return cur, ppid
        cur = ppid
    return pid, 0


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
        child, kitty = kitty_owner(int(cpid), procs) if cpid else (0, 0)
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
            kitty_pid=str(child) if cpid else "",
            kitty_proc=str(kitty) if kitty else "",
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


# the sort a UI offers, and what "state" means as an order: the ones that want you first,
# then the ones working, then the empty ones, which are interchangeable
STATE_ORDER = {"wait": 0, "busy": 1, "free": 2}
SORTS = ("state", "path")


def fuzzy(needle, hay):
    """Subsequence match. Returns (score, matched indices) or None; lowest score wins.

    Greedy forward to prove the match exists, then greedy backward from the last hit,
    which pulls the matched characters as far right as they will go and so collapses
    "cx" onto the trailing `cx` of ~/prj/ccx instead of taking the c before it.
    Every character skipped costs 2, or 1 when the match lands on a word start, so a
    match at the head of a path segment beats one buried mid-word."""
    low = hay.lower()
    idx, at = [], 0
    for c in needle:
        at = low.find(c, at)
        if at < 0:
            return None
        idx.append(at)
        at += 1
    for n in range(len(idx) - 2, -1, -1):
        idx[n] = low.rfind(needle[n], 0, idx[n + 1])
    score = 0
    for n, i in enumerate(idx):
        gap = i - idx[n - 1] - 1 if n else i
        score += gap * (1 if i == 0 or not hay[i - 1].isalnum() else 2)
    return score, idx


def rank(instances, needle="", sort="state"):
    """The list in display order, which both UIs want identically.

    Within a state the one stuck there longest goes on top, so the sessions that want you
    float up. A filter outranks the sort entirely: you typed those keys to reach one row,
    so the closest match goes first and enter takes it, with the sort breaking ties.
    """
    key = ((lambda i: (STATE_ORDER[i.state], i.since)) if sort == "state"
           else (lambda i: (i.short_path, i.pid)))
    if not needle:
        return sorted(instances, key=key)
    scored = []
    for i in instances:
        hits = [h for h in (fuzzy(needle, i.short_path), fuzzy(needle, i.summary)) if h]
        if hits:
            scored.append((min(s for s, _ in hits), i))
    return [i for _, i in sorted(scored, key=lambda p: (p[0], key(p[1])))]


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


def niri_window(pid):
    """The niri window id for a process, or None. niri is the compositor on this box.

    A kitty process here owns exactly one OS window, so its pid identifies the window;
    `single_instance` or `kitty @ launch --type=os-window` would break that and this
    would raise whichever of them niri lists first. Nothing else on Wayland can do
    better without kitty telling us which of its windows is where, which it cannot.
    """
    with contextlib.suppress(ValueError):
        for w in json.loads(sh("niri", "msg", "--json", "windows") or "[]"):
            if str(w.get("pid")) == str(pid):
                return w.get("id")
    return None


def raise_window(inst):
    """Bring the terminal's own window to the front. The per-platform half of the jump.

    macOS: `open -a kitty` activates the application, and send_kitty("focus-window")
    above has already decided which of its windows that means.

    Wayland: an app can only raise itself with an activation token handed to it from a
    recent interaction, which a poll loop and a menu bar click do not have, so kitty's
    focus-window moves the tab inside a window and leaves the window where it is
    (verified on niri: focus-window to two different windows in turn, and the focused
    window did not change either time). The compositor has to be asked directly, by its
    own id for the window, which niri_window() looks up from kitty's pid. That also
    switches to the workspace the window is on, which macOS gets from `open`.
    """
    if MAC:
        sh("open", "-a", "kitty")
    elif inst.kitty_proc and (wid := niri_window(inst.kitty_proc)) is not None:
        sh("niri", "msg", "action", "focus-window", "--id", str(wid))


def raise_target(inst):
    """What raise_window() would do with this instance, for `ccx doctor` to print."""
    if MAC:
        return "open -a kitty"
    if not inst.kitty_proc:
        return "(no kitty ancestor)"
    wid = niri_window(inst.kitty_proc)
    return f"niri {wid}" if wid is not None else f"(kitty {inst.kitty_proc} not in niri)"


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
    raise_window(inst)
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
        target = {"match": f"pid:{kitty_owner(int(pid), processes())[0]}"}
    send_kitty("set-window-title", target | {"title": name})

    def restore():
        send_kitty("set-window-title", target)     # no title: back to kitty's default

    ON_EXIT.append(restore)
    try:
        yield
    finally:
        ON_EXIT.remove(restore)
        restore()


# ------------------------------------------------------------------ the bell, inlined

# macOS's /System/Library/Sounds/Bottle.aiff, cut down to fit in a source file. The
# original is 223KB, which is 300KB of base64 and 180KB even under lzma. To redo it:
#
#     afconvert -f WAVE -d LEI16@22050 -c 2 Bottle.aiff b.wav    # a real resampler
#     x = (left + right) / 2, cut to 0.40s, 40ms fade, round(x / 16) * 16
#     base64(lzma.compress(second differences of x, as little-endian int16))
#
# The cuts cost noise 63dB under the peak, against a recording whose own quietest 10ms
# is 53dB under it; the 0.37s dropped off the end is that floor and nothing else, peaking
# 45dB down. The second differences are what makes it small: a 185Hz tone barely moves
# between samples, so 17640 bytes of PCM that lzma alone gets to 6120 go to 3128.
RATE = 22050
BOTTLE = """
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
"""
