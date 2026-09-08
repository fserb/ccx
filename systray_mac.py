"""The macOS systray: a menu bar item, a borderless panel, and a Carbon hotkey.

Everything platform-independent is in systray.py; this is the drawing and the macOS
plumbing. Two things here were verified before the rest was written, because either one
could have sunk the design:

- the hotkey is Carbon's RegisterEventHotKey through ctypes. It is the one global-shortcut
  API that needs neither an .app bundle nor an Accessibility grant, so this stays a script
  you run rather than an app you install. Measured: both calls return noErr from a plain
  `uv run --script` process, with no permission prompt, and the handler fires
- this process has no controlling terminal when launched outside a terminal, where
  open("/dev/tty") fails with ENXIO. claudes.send_kitty() reaches kitty through the target
  window's own tmux client tty instead, which needs no tty of our own
"""

import ctypes
import time

import objc
from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory,
                    NSBackingStoreBuffered, NSBezierPath, NSBoldFontMask, NSColor,
                    NSEventMaskLeftMouseDown, NSEventMaskRightMouseDown,
                    NSEventModifierFlagCommand, NSEventModifierFlagControl,
                    NSEventTypeRightMouseDown, NSFont, NSFontAttributeName,
                    NSFontManager, NSFontWeightRegular,
                    NSForegroundColorAttributeName, NSImage, NSImageOnly,
                    NSLineBreakByTruncatingHead, NSLineBreakByTruncatingTail,
                    NSMenu, NSMenuItem, NSMutableAttributedString,
                    NSMutableParagraphStyle, NSPanel, NSParagraphStyleAttributeName,
                    NSScreen, NSStatusBar, NSTextAlignmentRight, NSTimer,
                    NSVariableStatusItemLength, NSView, NSWindowStyleMaskBorderless)
from Foundation import NSMakeRect, NSMakeSize, NSMaxX, NSMinX, NSMinY, NSObject

from systray import (ACCENT, AGE_X, BG, CURSOR, DIM, EDGE, FOOT, GOLD, HEAD, HINT, HINTS,
                     ICON, IDLE, MAUVE, MAX_ROWS, NUM_X, NUMBERS, PAD, PATH_X, POLL, ROW,
                     STATE, STATE_X, SUM_X, TEXT, WIDTH, Model, icon_dots)

# ------------------------------------------------------------------- the global hotkey

carbon = ctypes.CDLL("/System/Library/Frameworks/Carbon.framework/Carbon")


class EventTypeSpec(ctypes.Structure):
    _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]


class EventHotKeyID(ctypes.Structure):
    _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]


HANDLER = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.c_void_p)
CMD, SHIFT, OPTION, CONTROL = 0x0100, 0x0200, 0x0800, 0x1000
HOTKEY = (0x26, CONTROL | OPTION | CMD)     # ctrl+opt+cmd+J; 0x26 is the J key
HOTKEY_NAME = "^⌥⌘J"
REPEAT_GAP = 0.25                           # holding the keys auto-repeats the event

_handler = None          # the ctypes callback, kept alive: Carbon holds only a raw pointer


def register_hotkey(fn):
    """Call fn() when the hotkey is pressed. Returns the OSStatus of the registration."""
    global _handler
    last = [0.0]

    def fired(caller, event, user_data):
        now = time.monotonic()
        if now - last[0] > REPEAT_GAP:      # a held key repeats; one press is one toggle
            last[0] = now
            fn()
        return 0

    _handler = HANDLER(fired)
    carbon.GetApplicationEventTarget.restype = ctypes.c_void_p
    carbon.InstallEventHandler.argtypes = [ctypes.c_void_p, HANDLER, ctypes.c_ulong,
                                           ctypes.POINTER(EventTypeSpec), ctypes.c_void_p,
                                           ctypes.c_void_p]
    carbon.RegisterEventHotKey.argtypes = [ctypes.c_uint32, ctypes.c_uint32, EventHotKeyID,
                                           ctypes.c_void_p, ctypes.c_uint32,
                                           ctypes.POINTER(ctypes.c_void_p)]
    target = carbon.GetApplicationEventTarget()
    spec = EventTypeSpec(int.from_bytes(b"keyb", "big"), 5)   # kEventHotKeyPressed
    carbon.InstallEventHandler(target, _handler, 1, ctypes.byref(spec), None, None)
    ref = ctypes.c_void_p()
    key, mods = HOTKEY
    return carbon.RegisterEventHotKey(key, mods, EventHotKeyID(0x63636A70, 1), target, 0,
                                      ctypes.byref(ref))


# -------------------------------------------------------------------------- the drawing

def rgb(text, alpha=1.0):
    r, g, b = (int(text.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return NSColor.colorWithSRGBRed_green_blue_alpha_(r, g, b, alpha)


FONT, SIZE = "Inconsolata", 16
MONO = (NSFont.fontWithName_size_(FONT, SIZE)
        or NSFont.monospacedSystemFontOfSize_weight_(SIZE, NSFontWeightRegular))
BOLD = NSFontManager.sharedFontManager().convertFont_toHaveTrait_(MONO, NSBoldFontMask)


def paragraph(align_right=False, head=False):
    style = NSMutableParagraphStyle.alloc().init()
    # a path truncated at the head keeps the part that identifies it, the tail
    style.setLineBreakMode_(NSLineBreakByTruncatingHead if head else NSLineBreakByTruncatingTail)
    if align_right:
        style.setAlignment_(NSTextAlignmentRight)
    return style


def text(string, color, font=MONO, hits=(), **kw):
    """One field, with the fuzzy match's characters picked out in the accent color."""
    attrs = {NSForegroundColorAttributeName: rgb(color), NSFontAttributeName: font,
             NSParagraphStyleAttributeName: paragraph(**kw)}
    out = NSMutableAttributedString.alloc().initWithString_attributes_(string, attrs)
    for i in hits:
        if i < len(string):
            out.addAttribute_value_range_(NSForegroundColorAttributeName, rgb(ACCENT), (i, 1))
            out.addAttribute_value_range_(NSFontAttributeName, BOLD, (i, 1))
    return out


# ---------------------------------------------------------------------------- the icon

# `busy` and `free` are not the panel's colors: the panel has its own near-black behind
# it, the menu bar has the desktop, and #626262 on a dark one is nearly invisible, so free
# is labelColor. That is also why the drawing is a handler and not a finished bitmap:
# AppKit re-runs it whenever the image is drawn, so the dynamic color follows a switch to
# light mode without us noticing the switch.
DOTS = {"wait": rgb(GOLD), "busy": rgb("#e9e9e9")}   # free is labelColor, below


def icon(states):
    """The menu bar image: one dot per instance, laid out by systray.icon_dots()."""
    spots = icon_dots(len(states))

    def rect(spot):
        cx, cy, r = spot                    # cy comes down from the top, this view's is up
        return NSMakeRect(cx - r, ICON - cy - r, r * 2, r * 2)

    def draw(_):
        for state, spot in zip(states, spots):
            if state in DOTS:
                DOTS[state].set()
            else:
                NSColor.labelColor().colorWithAlphaComponent_(0.45).set()
            NSBezierPath.bezierPathWithOvalInRect_(rect(spot)).fill()
        if not states:      # nothing running still needs something to click on
            ring = NSBezierPath.bezierPathWithOvalInRect_(rect(spots[0]))
            ring.setLineWidth_(1.2)
            NSColor.labelColor().colorWithAlphaComponent_(0.35).set()
            ring.stroke()
        return True

    img = NSImage.imageWithSize_flipped_drawingHandler_(NSMakeSize(ICON, ICON), False, draw)
    img.setTemplate_(False)     # the colors are the message; a template image is one tint
    return img


class ListView(NSView):
    """Draws the whole panel and owns its keyboard. One view, no NSTableView.

    A dozen rows of five fields each is less code drawn by hand than it is wired through
    a table's data source, and drawing it means the fuzzy match's highlighted characters
    are just another attribute run.
    """

    def isFlipped(self):
        return True          # so rows go top-down and y grows the way the list reads

    def acceptsFirstResponder(self):
        return True

    def drawRect_(self, rect):
        model = self.model
        bounds = self.bounds()
        NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(bounds, 10, 10).addClip()
        rgb(BG, 0.96).set()
        NSBezierPath.fillRect_(bounds)

        head = NSMakeRect(PAD + 2, PAD, WIDTH - 2 * PAD, HEAD - 6)
        if model.filter:
            text(f"/{model.filter}", ACCENT).drawInRect_(head)
        else:
            text("type to filter", HINT).drawInRect_(head)
        count, color = model.counter()
        text(count, color, align_right=True).drawInRect_(head)

        rgb(EDGE).set()
        NSBezierPath.fillRect_(NSMakeRect(0, PAD + HEAD - 5, WIDTH, 1))

        top = PAD + HEAD
        if not model.rows:
            text(model.empty(), DIM).drawInRect_(
                NSMakeRect(PAD + 2, top + 3, WIDTH, ROW))
        for n, inst in enumerate(model.rows[:MAX_ROWS]):
            y = top + n * ROW
            if inst.pid == model.selected:
                rgb(CURSOR).set()
                NSBezierPath.fillRect_(NSMakeRect(2, y, WIDTH - 4, ROW))
            label, color = STATE[inst.state]
            ty = y + 3
            text(NUMBERS[n] if n < len(NUMBERS) else " ", DIM).drawInRect_(
                NSMakeRect(NUM_X, ty, 14, ROW))
            text(label, color, font=BOLD).drawInRect_(NSMakeRect(STATE_X, ty, 52, ROW))
            text(inst.age, DIM, align_right=True).drawInRect_(NSMakeRect(AGE_X, ty, 34, ROW))
            text(inst.short_path, MAUVE, hits=model.match_marks(inst.short_path), head=True
                 ).drawInRect_(NSMakeRect(PATH_X, ty, SUM_X - PATH_X - 8, ROW))
            text(inst.summary, TEXT if inst.state == "wait" else IDLE,
                 hits=model.match_marks(inst.summary)).drawInRect_(
                     NSMakeRect(SUM_X, ty, WIDTH - SUM_X - PAD, ROW))

        foot = NSMakeRect(PAD + 2, bounds.size.height - FOOT, WIDTH - 2 * PAD, FOOT - 4)
        note, note_color = model.note()
        if note:
            text(note, note_color).drawInRect_(foot)
        text(HINTS, DIM, align_right=True).drawInRect_(foot)

    def mouseDown_(self, event):
        point = self.convertPoint_fromView_(event.locationInWindow(), None)
        row = int((point.y - (PAD + HEAD)) // ROW)
        if 0 <= row < min(len(self.model.rows), MAX_ROWS):
            self.model.jump_row(row)

    def keyDown_(self, event):
        code = event.keyCode()
        mods = event.modifierFlags()
        if ((mods & (NSEventModifierFlagCommand | NSEventModifierFlagControl))
                and (event.charactersIgnoringModifiers() or "").lower() == "q"):
            # charactersIgnoringModifiers, because ctrl+q arrives as \x11 in characters()
            self.model.key(name="quit")
            return
        name = {53: "escape", 36: "enter", 76: "enter", 51: "backspace",
                125: "down", 126: "up"}.get(code, "")
        self.model.key(name=name, char="" if name else (event.characters() or ""))


class Panel(NSPanel):
    def canBecomeKeyWindow(self):
        return True          # a borderless panel refuses keys without this


# ------------------------------------------------------------------------------ the app

class Systray(NSObject):

    def init(self):
        self = objc.super(Systray, self).init()
        self.model = Model(redraw=self.redraw, close=self.hide, quit=self.leave)
        self.hidden_at = 0.0
        self.states = None         # what the icon last drew; None so the first poll draws

        bar = NSStatusBar.systemStatusBar()
        self.item = bar.statusItemWithLength_(NSVariableStatusItemLength)
        self.item.button().setImagePosition_(NSImageOnly)
        self.item.button().setTarget_(self)
        self.item.button().setAction_(b"toggle:")
        self.item.button().sendActionOn_(NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown)

        view = ListView.alloc().initWithFrame_(NSMakeRect(0, 0, WIDTH, 100))
        view.model = self.model
        self.view = view
        self.panel = Panel.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(0, 0, WIDTH, 100), NSWindowStyleMaskBorderless,
            NSBackingStoreBuffered, False)
        self.panel.setOpaque_(False)
        self.panel.setBackgroundColor_(NSColor.clearColor())
        self.panel.setHasShadow_(True)
        self.panel.setLevel_(3)            # NSFloatingWindowLevel
        self.panel.setContentView_(view)
        self.panel.setDelegate_(self)

        self.poll_(None)
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            POLL, self, b"poll:", None, True)
        return self

    def poll_(self, timer):
        self.model.poll()

    @objc.python_method
    def redraw(self):
        self.reicon()
        if self.panel.isVisible():
            self.layout()
            self.view.setNeedsDisplay_(True)

    @objc.python_method
    def reicon(self):
        """Redraw the menu bar dots, if what they would say has changed.

        The states in rank order are the whole of the icon, so comparing that list is
        exactly the redraw test; a poll where nothing moved touches nothing. It has to be
        the ordered list and not the counts, since which dot is which color is what moves
        when a session changes state.
        """
        states = self.model.states()
        if states == self.states:
            return
        self.states = states
        self.item.button().setImage_(icon(states))

    # ---- the panel

    @objc.python_method
    def layout(self):
        height = self.model.height()
        frame = self.item.button().window().frame()
        screen = NSScreen.mainScreen().frame()
        x = min(max(NSMinX(screen) + 8, NSMaxX(frame) - WIDTH), NSMaxX(screen) - WIDTH - 8)
        self.panel.setFrame_display_(
            NSMakeRect(x, NSMinY(frame) - height - 6, WIDTH, height), True)
        self.view.setFrame_(NSMakeRect(0, 0, WIDTH, height))

    @objc.python_method
    def show(self):
        self.model.opened()
        self.layout()
        # an accessory app has to activate for the panel to take keys at all
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        self.panel.makeKeyAndOrderFront_(None)
        self.panel.makeFirstResponder_(self.view)

    @objc.python_method
    def hide(self):
        self.hidden_at = time.monotonic()
        self.panel.orderOut_(None)

    @objc.python_method
    def leave(self):
        NSApplication.sharedApplication().terminate_(None)

    @objc.python_method
    def toggle(self):
        """Open the panel, or close it if it is up.

        Clicking the status item makes the status bar key, so the panel resigns and
        windowDidResignKey_ has already hidden it by the time this runs. Without the
        moment of memory, that click would read as "it is closed, open it" and the panel
        would flicker shut and straight back open, which is one of two ways in (the
        hotkey is the other, and it *does* arrive with the panel still up).
        """
        if self.panel.isVisible() or time.monotonic() - self.hidden_at < 0.25:
            self.hide()
        else:
            self.show()

    def toggle_(self, sender):
        # a right click, or a control click, asks for the menu rather than the panel: it
        # is the one place to put Quit, since a menu bar app has no window to close
        event = NSApplication.sharedApplication().currentEvent()
        if event and (event.type() == NSEventTypeRightMouseDown
                      or event.modifierFlags() & NSEventModifierFlagControl):
            self.menu()
            return
        self.toggle()

    @objc.python_method
    def menu(self):
        """Show the quit menu under the status item.

        Setting the item's menu makes *left* click open it too, which would take the panel
        away, so it is set, clicked and unset. popUpStatusItemMenu_ does this in one call
        and has been deprecated since 10.14.
        """
        menu = NSMenu.alloc().init()
        menu.addItemWithTitle_action_keyEquivalent_(
            f"ccjump-systray  ·  {HOTKEY_NAME}", None, "").setEnabled_(False)
        menu.addItem_(NSMenuItem.separatorItem())
        quit_item = menu.addItemWithTitle_action_keyEquivalent_("Quit", b"terminate:", "q")
        quit_item.setTarget_(NSApplication.sharedApplication())
        self.item.setMenu_(menu)
        self.item.button().performClick_(None)
        self.item.setMenu_(None)

    def windowDidResignKey_(self, note):
        self.hide()          # clicking away closes it, like a menu


def run(argv):
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)   # no dock icon
    systray = Systray.alloc().init()
    if err := register_hotkey(systray.toggle):   # pressing it again puts it away
        print(f"RegisterEventHotKey failed: {err}; the menu bar icon still works")
    if "--show" in argv:
        # open the panel without the hotkey, which is the only way to look at it from a
        # script: clicking the status item needs Accessibility, pressing the key needs you
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            0.3, systray, b"toggle:", None, False)
    app.run()
