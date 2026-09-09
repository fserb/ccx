"""The Linux systray: a StatusNotifierItem, a Wayland layer-shell panel, cairo drawing.

Everything platform-independent is in systray.py; this is the drawing and the Wayland and
DBus plumbing. Three things here were verified before the rest was written, because any
of them could have sunk the design:

- a wlr-layer-shell surface with `on_demand` keyboard interactivity takes the keyboard on
  niri the moment it is shown, so the panel can be a keyboard-driven launcher with no
  toplevel window and no window management. Measured: focus-in fires on show and
  has_toplevel_focus() reads true
- the tray item is the KDE StatusNotifierItem protocol over the session bus, exported
  with Gio's own DBus (so PyGObject is the only dependency, and there is no dbus binding
  in here). Verified against the running host: it appeared in the watcher's
  RegisteredStatusNotifierItems, the host then read every property including IconPixmap,
  and the dots drew in the bar
- the icon says what it says in brightness, not hue. See DOTS

There is no global hotkey: on Wayland the compositor owns the keyboard, and an
application cannot ask for a shortcut. So the hotkey is a niri bind that runs
`ccjump-systray --toggle`, which sends SIGUSR1 to the running one. Add to niri's config:

    Mod+J repeat=false hotkey-overlay-title="ccjump" {
        spawn "/home/fserb/prj/ccjump/ccjump-systray" "--toggle";
    }
"""

import itertools
import math
import os
import signal

import cairo
import gi

# Gdk has to be pinned as well as Gtk: it is imported first below, and gi loads the
# newest version of a namespace nobody asked a version of, which here is Gdk 4.0
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
gi.require_version("PangoCairo", "1.0")
from gi.repository import Gdk, Gio, GLib, Gtk, GtkLayerShell, Pango, PangoCairo  # noqa: E402

from systray import (ACCENT, AGE_X, BG, CURSOR, DIM, EDGE, FOOT, GOLD, HEAD, HINT, HINTS,
                     IDLE, MAUVE, MAX_ROWS, NUM_X, NUMBERS, PAD, PATH_X, POLL, ROW, STATE,
                     STATE_X, SUM_X, TEXT, WIDTH, Model, icon_dots)  # noqa: E402

# kitty resolves `font_family` to plain `monospace` on this box (Inconsolata is not
# installed here, only named as the bold face), so the panel asks for the same thing and
# lands on the same face the terminal draws.
#
# The size is not a matter of taste: the column offsets in systray.py were laid out
# against Inconsolata at 16 AppKit points, which advances 8px per character. Pango points
# are 1/72in against 96dpi where an AppKit point is a pixel, so the equivalent is smaller,
# and DejaVu Sans Mono advances 0.602em. Measured: 10 gives exactly 8.0px per character
# and fits "◐ busy" in 48 of the state column's 52, where 11 gives 9.0 and 54, which is
# how the state column came to read "◐ bu…" the first time this ran.
FONT, SIZE = "monospace", 10
DESC = Pango.FontDescription(f"{FONT} {SIZE}")
BOLD_DESC = Pango.FontDescription(f"{FONT} Bold {SIZE}")
LINE = 17                # what a line of it measures, to center text in a band
TEXT_DY = (ROW - LINE) // 2      # the layout's top inside a row, so the text sits on it

# Where the panel hangs: hard against the bar, in from the right edge, which is where the
# tray item that opens it lives. Anchoring beats following the click, because the hotkey
# opens it too and a launcher that appears somewhere new each time is one you have to look
# for.
#
# The top margin is 0 because every pixel of gap is a way to lose the panel. niri runs
# focus-follows-mouse, so dragging the pointer from the tray item down to the panel across
# anything focusable hands focus to it, and the focus-out closes the panel before you
# arrive. At 44 the panel's top edge sat at y=86 with the window underneath starting at
# y=42, so the trip crossed 44px of another window and the panel shut every time.
#
# 0 does not mean the top of the screen: the bar reserves an exclusive zone (42px here,
# with its pill ending at 34), and an anchored surface that reserves nothing of its own is
# placed below it. That leaves only the bar's own padding in between, which belongs to no
# window, so there is nothing there to take the focus. Going tighter is not possible:
# margins of -8 and -12 both land in exactly the same place, so niri clamps a
# non-exclusive surface out of the reserved zone rather than letting it overlap.
TOP_MARGIN, RIGHT_MARGIN = 0, 12
RADIUS = 10
SETTLE = 0.25            # ignore a focus-out this soon after showing (see Panel.left)

# ------------------------------------------------------------------------- the drawing


def rgba(color, alpha=1.0):
    r, g, b = (int(color.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return r, g, b, alpha


def markup(string, hits=()):
    """One field's text with the fuzzy match's characters picked out in the accent color.

    Grouped into runs rather than wrapped per character, so a match spanning three
    adjacent characters is one span and Pango kerns across it as it would untouched.
    """
    hits = set(hits)
    out = []
    for marked, run in itertools.groupby(enumerate(string), key=lambda p: p[0] in hits):
        text = GLib.markup_escape_text("".join(c for _, c in run))
        out.append(f'<span foreground="{ACCENT}" weight="bold">{text}</span>'
                   if marked else text)
    return "".join(out)


def field(cr, x, y, w, string, color, hits=(), bold=False, right=False, head=False):
    """Draw one column of one row, ellipsized to fit and optionally right-aligned.

    `head` ellipsizes at the *start*, which is what a path wants: the tail is the part
    that identifies it.
    """
    layout = PangoCairo.create_layout(cr)
    layout.set_font_description(BOLD_DESC if bold else DESC)
    layout.set_single_paragraph_mode(True)
    layout.set_width(int(w * Pango.SCALE))
    layout.set_ellipsize(Pango.EllipsizeMode.START if head else Pango.EllipsizeMode.END)
    layout.set_alignment(Pango.Alignment.RIGHT if right else Pango.Alignment.LEFT)
    layout.set_markup(f'<span foreground="{color}">{markup(string, hits)}</span>', -1)
    cr.move_to(x, y)
    PangoCairo.show_layout(cr, layout)


def rounded(cr, x, y, w, h, r):
    cr.new_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


# ---------------------------------------------------------------------------- the icon

# The dots have to say what they say in *brightness*, not hue. A status bar is free to
# recolor tray icons, and this one does: DankMaterialShell's `systemTrayIconTintMode` is
# "secondary" here, which desaturates the pixmap and colorizes it toward the theme. Fed
# pure red, green and blue dots it handed back dark, mid and darkest grey, in luminance
# order, so hue carries nothing and luminance carries everything. Hence wait is the
# brightest thing in the icon and free the faintest; the gold is still gold for anyone
# whose bar leaves icons alone. The wait dot is also drawn wider than the rest (see
# icon_dots), which is the one signal a tint mode cannot take away: a bar that flattens
# every dot to one color still shows a bigger one where something wants you.
DOTS = {"wait": (GOLD, 1.0), "busy": ("#c8c8c8", 0.55)}
FREE = ("#c8c8c8", 0.24)
SIZES = (22, 44)         # the host picks whichever fits its bar; 44 covers a 2x scale


def pixmap(states, px):
    """(width, height, ARGB32 bytes) for the dot grid, in the format SNI asks for.

    Drawn with cairo, then turned into what the protocol wants: bytes in ARGB order
    (network byte order, where cairo's own buffer is BGRA on a little-endian box) and
    straight rather than premultiplied alpha, since a host loading this into a Qt
    QImage::Format_ARGB32 will read it as straight. Getting either wrong shows up as
    dots that are invisible or the wrong brightness, not as an error.
    """
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, px, px)
    cr = cairo.Context(surf)
    spots = icon_dots(states, px)
    for state, (cx, cy, r) in zip(states, spots):
        cr.set_source_rgba(*rgba(*DOTS.get(state, FREE)))
        cr.arc(cx, cy, r, 0, 2 * math.pi)
        cr.fill()
    if not states:           # nothing running still needs something to click on
        cx, cy, r = spots[0]
        cr.set_source_rgba(*rgba(*FREE))
        cr.set_line_width(max(1.0, px / 18))
        cr.arc(cx, cy, r, 0, 2 * math.pi)
        cr.stroke()
    surf.flush()

    stride = surf.get_stride()
    raw = bytes(surf.get_data())
    raw = b"".join(raw[y * stride:y * stride + px * 4] for y in range(px))
    alpha = raw[3::4]

    def straight(channel):   # undo cairo's premultiplication
        return bytes(min(255, c * 255 // a) if a else 0 for c, a in zip(channel, alpha))

    out = bytearray(len(raw))
    out[0::4], out[1::4] = alpha, straight(raw[2::4])
    out[2::4], out[3::4] = straight(raw[1::4]), straight(raw[0::4])
    return (px, px, bytes(out))


# ----------------------------------------------------------------------- the tray item

WATCHER = "org.kde.StatusNotifierWatcher"
ITEM_PATH = "/StatusNotifierItem"

# only the properties a host actually reads, which is all of them: the running one asked
# for every single name below before it drew anything
ITEM_XML = """
<node><interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="OverlayIconName" type="s" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="Activate">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
  </method>
  <method name="SecondaryActivate">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
  </method>
  <method name="Scroll">
    <arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/>
  </method>
  <signal name="NewIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg name="status" type="s"/></signal>
  <signal name="NewTitle"/>
</interface></node>
"""


class Tray:
    """The status bar item: a StatusNotifierItem on the session bus.

    The host reads the icon back out of us whenever we say it changed, so `states` and
    `tip` are just held here and NewIcon/NewToolTip are the nudge. The watcher is watched
    rather than called once: quickshell gets restarted a lot, and a tray item that only
    registered at startup silently disappears the first time its host does.
    """

    def __init__(self, activate):
        self.activate = activate
        self.states, self.tip = [], ""
        self.name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        info = Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0]
        register = (getattr(self.conn, "register_object_with_closures2", None)
                    or self.conn.register_object)
        register(ITEM_PATH, info, self.called, self.prop, None)
        Gio.bus_own_name_on_connection(
            self.conn, self.name, Gio.BusNameOwnerFlags.NONE,
            lambda *a: Gio.bus_watch_name_on_connection(
                self.conn, WATCHER, Gio.BusNameWatcherFlags.NONE,
                lambda *b: self.enlist(), None),
            None)

    def enlist(self):
        """Tell the watcher we exist, every time a watcher turns up."""
        try:
            self.conn.call_sync(WATCHER, "/StatusNotifierWatcher", WATCHER,
                                "RegisterStatusNotifierItem",
                                GLib.Variant("(s)", (self.name,)), None,
                                Gio.DBusCallFlags.NONE, 2000, None)
        except GLib.Error as e:
            print(f"cannot register with {WATCHER}: {e.message}")

    def prop(self, conn, sender, path, iface, name, *rest):
        if name == "Category":
            return GLib.Variant("s", "ApplicationStatus")
        if name in ("Id", "Title"):
            return GLib.Variant("s", "ccjump")
        if name == "Status":
            return GLib.Variant("s", "Active")
        if name in ("IconName", "OverlayIconName", "AttentionIconName"):
            return GLib.Variant("s", "")      # the icon is a pixmap, not a theme name
        if name == "IconPixmap":
            return GLib.Variant("a(iiay)", [pixmap(self.states, px) for px in SIZES])
        if name == "ToolTip":
            return GLib.Variant("(sa(iiay)ss)", ("", [], "ccjump", self.tip))
        if name == "ItemIsMenu":
            return GLib.Variant("b", False)   # we answer clicks; there is no menu
        if name == "Menu":
            return GLib.Variant("o", "/NoDBusMenu")
        return None

    def called(self, conn, sender, path, iface, method, params, invocation, *rest):
        if method in ("Activate", "SecondaryActivate"):
            self.activate()
        invocation.return_value(None)

    def draw(self, states, tip):
        """Push a new icon, if what it would say has changed.

        The states in rank order are the whole of the icon, so comparing that list is
        exactly the redraw test; a poll where nothing moved sends nothing. It has to be
        the ordered list and not the counts, since which dot is which is what moves when
        a session changes state.
        """
        changed = ([] if states == self.states else ["NewIcon"]
                   ) + ([] if tip == self.tip else ["NewToolTip"])
        self.states, self.tip = states, tip     # before the signals: the host reads back
        for name in changed:
            self.conn.emit_signal(None, ITEM_PATH, "org.kde.StatusNotifierItem", name, None)


# --------------------------------------------------------------------------- the panel

class Panel:
    """A borderless layer-shell surface that draws the list and owns the keyboard."""

    def __init__(self):
        self.model = Model(redraw=self.redraw, close=self.hide, quit=Gtk.main_quit)
        self.hidden_at = self.shown_at = 0.0

        self.win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.win.set_app_paintable(True)
        if visual := self.win.get_screen().get_rgba_visual():
            self.win.set_visual(visual)       # without this the corners are black, not clear
        GtkLayerShell.init_for_window(self.win)
        GtkLayerShell.set_layer(self.win, GtkLayerShell.Layer.OVERLAY)
        # on_demand rather than exclusive: both take the keyboard on show, but only
        # on_demand gives it up when you click something else, and letting go is what
        # makes the panel close like a menu instead of holding the keyboard until it is
        # dismissed. Which output it lands on is deliberately not set: niri puts an
        # unpinned layer surface on the focused output, which is where a launcher belongs,
        # and it only hands the keyboard to a surface that is *on* the focused output.
        # Pinning it to the other monitor (`set_monitor`) left it visible and dead: no
        # focus-in, has_toplevel_focus() false, every keystroke going elsewhere
        GtkLayerShell.set_keyboard_mode(self.win, GtkLayerShell.KeyboardMode.ON_DEMAND)
        GtkLayerShell.set_anchor(self.win, GtkLayerShell.Edge.TOP, True)
        GtkLayerShell.set_anchor(self.win, GtkLayerShell.Edge.RIGHT, True)
        GtkLayerShell.set_margin(self.win, GtkLayerShell.Edge.TOP, TOP_MARGIN)
        GtkLayerShell.set_margin(self.win, GtkLayerShell.Edge.RIGHT, RIGHT_MARGIN)

        self.area = Gtk.DrawingArea()
        self.area.set_size_request(WIDTH, self.model.height())
        self.area.connect("draw", self.paint)
        self.area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.area.connect("button-press-event", self.clicked)
        self.win.add(self.area)
        self.win.connect("key-press-event", self.typed)
        self.win.connect("focus-out-event", self.left)
        self.win.connect("delete-event", lambda *a: self.hide() or True)

    # ---- showing and hiding

    def redraw(self):
        if self.win.get_visible():
            height = self.model.height()
            self.area.set_size_request(WIDTH, height)
            self.win.resize(WIDTH, height)
            self.area.queue_draw()

    def show(self):
        self.model.opened()
        self.area.set_size_request(WIDTH, self.model.height())
        self.shown_at = GLib.get_monotonic_time() / 1e6
        self.win.show_all()
        self.win.present()

    def hide(self):
        self.hidden_at = GLib.get_monotonic_time() / 1e6
        self.win.hide()

    def toggle(self):
        """Open the panel, or close it if it is up.

        The moment of memory is for the tray item: clicking it can hand us a focus-out
        that hides the panel before Activate arrives, and without this that click would
        read as "it is closed, open it" and the panel would flicker shut and back open.
        """
        now = GLib.get_monotonic_time() / 1e6
        if self.win.get_visible() or now - self.hidden_at < SETTLE:
            self.hide()
        else:
            self.show()

    def left(self, *_):
        """Clicking away closes it, like a menu.

        Guarded by SETTLE because the surface is created and focused in the same breath
        as being shown, and a focus-out arriving inside that window is the compositor
        settling rather than you looking elsewhere.
        """
        if GLib.get_monotonic_time() / 1e6 - self.shown_at > SETTLE:
            self.hide()
        return False

    # ---- input

    KEYS = {Gdk.KEY_Escape: "escape", Gdk.KEY_Return: "enter", Gdk.KEY_KP_Enter: "enter",
            Gdk.KEY_BackSpace: "backspace", Gdk.KEY_Down: "down", Gdk.KEY_Up: "up",
            Gdk.KEY_Tab: "down", Gdk.KEY_ISO_Left_Tab: "up"}

    def typed(self, _win, event):
        # escape only closes the panel, so ctrl+q and ctrl+c are the keys that leave for
        # good. There is no menu to put Quit in: a layer surface has no titlebar
        if event.state & Gdk.ModifierType.CONTROL_MASK:
            if Gdk.keyval_name(event.keyval) in ("q", "c"):
                self.model.key(name="quit")
            return True
        if name := self.KEYS.get(event.keyval):
            self.model.key(name=name)
            return True
        code = Gdk.keyval_to_unicode(event.keyval)
        self.model.key(char=chr(code) if code else "")
        return True

    def clicked(self, _area, event):
        row = int((event.y - (PAD + HEAD)) // ROW)
        if 0 <= row < min(len(self.model.rows), MAX_ROWS):
            self.model.jump_row(row)
        return True

    # ---- drawing

    def paint(self, _area, cr):
        """The whole panel, in the same five columns and the same order as systray_mac."""
        model = self.model
        height = model.height()
        cr.set_operator(cairo.OPERATOR_SOURCE)
        rounded(cr, 0, 0, WIDTH, height, RADIUS)
        cr.set_source_rgba(*rgba(BG, 0.96))
        cr.fill()
        cr.set_operator(cairo.OPERATOR_OVER)

        head = PAD + (HEAD - 6 - LINE) // 2
        if model.filter:
            field(cr, PAD + 2, head, WIDTH - 2 * PAD, f"/{model.filter}", ACCENT)
        else:
            field(cr, PAD + 2, head, WIDTH - 2 * PAD, "type to filter", HINT)
        count, color = model.counter()
        field(cr, PAD + 2, head, WIDTH - 2 * PAD, count, color, right=True)

        cr.set_source_rgba(*rgba(EDGE))
        cr.rectangle(0, PAD + HEAD - 5, WIDTH, 1)
        cr.fill()

        top = PAD + HEAD
        if not model.rows:
            field(cr, PAD + 2, top + TEXT_DY, WIDTH - 2 * PAD, model.empty(), DIM)
        for n, inst in enumerate(model.rows[:MAX_ROWS]):
            y = top + n * ROW
            if inst.pid == model.selected:
                cr.set_source_rgba(*rgba(CURSOR))
                cr.rectangle(2, y, WIDTH - 4, ROW)
                cr.fill()
            label, color = STATE[inst.state]
            ty = y + TEXT_DY
            field(cr, NUM_X, ty, 14, NUMBERS[n] if n < len(NUMBERS) else " ", DIM)
            field(cr, STATE_X, ty, 52, label, color, bold=True)
            field(cr, AGE_X, ty, 34, inst.age, DIM, right=True)
            field(cr, PATH_X, ty, SUM_X - PATH_X - 8, inst.short_path, MAUVE,
                  hits=model.match_marks(inst.short_path), head=True)
            field(cr, SUM_X, ty, WIDTH - SUM_X - PAD, inst.summary,
                  TEXT if inst.state == "wait" else IDLE,
                  hits=model.match_marks(inst.summary))

        foot = height - FOOT + (FOOT - 4 - LINE) // 2
        note, note_color = model.note()
        if note:
            field(cr, PAD + 2, foot, WIDTH - 2 * PAD, note, note_color)
        field(cr, PAD + 2, foot, WIDTH - 2 * PAD, HINTS, DIM, right=True)
        return True


# ------------------------------------------------------------------------------ the app

def run(argv):
    panel = Panel()
    tray = Tray(panel.toggle)

    def tick():
        panel.model.poll()
        waiting = sum(i.state == "wait" for i in panel.model.instances)
        tray.draw(panel.model.states(),
                  f"{waiting} waiting of {len(panel.model.instances)}")
        return True

    tick()
    GLib.timeout_add(int(POLL * 1000), tick)
    # the hotkey, such as it can be: a niri bind runs `--toggle`, which signals us
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1,
                         lambda *a: panel.toggle() or True)
    if "--show" in argv:
        GLib.timeout_add(300, lambda: panel.show() or False)
    Gtk.main()
