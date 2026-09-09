"""What the systray shows and every key it answers to, with no platform in it.

The macOS and Linux systrays have almost nothing in common at the drawing layer: one is
AppKit and NSStatusItem, the other is cairo on a Wayland layer surface and a DBus
StatusNotifierItem. What they do share is everything above that, and it all lives here:
the poll, the filter, the row under the cursor, which key does what, the palette, the
geometry the rows are laid out on, and where the icon's dots go.

So a backend (systray_mac, systray_linux) owns exactly three things: a window, a tray
item, and a main loop. It builds a Model, hands it the three hooks it needs to reach back
into the UI (redraw, close, quit), feeds it keys, and reads it while drawing. Nothing
here imports a toolkit, and nothing here knows which one is running.
"""

import math

from claudes import StateClock, discover, fuzzy, jump, play, rank

POLL = 1.5               # same cadence as the TUI, so the bell lands as promptly
NUMBERS = "1234567890"   # the digits label the first ten rows, in the order drawn

# ------------------------------------------------------------------------- the look

# the TUI's palette, out of ~/.config/kitty/kitty.conf, so the tools look like one
ACCENT, MAUVE, DIM, TEXT = "#ceaadf", "#b8a0be", "#626262", "#d6d6dc"
BG, EDGE, CURSOR = "#0e0b12", "#35284a", "#2a1e38"
GOLD, IDLE, HINT, ERROR = "#ffd500", "#82828a", "#4a4a55", "#df6565"
STATE = {"wait": ("● wait", GOLD), "free": ("◌ free", DIM), "busy": ("◐ busy", "#93aeaa")}

# one point on macOS and one logical pixel on Wayland are close enough to the same size
# that both panels lay out on these, so a row is a row and the columns line up either way
WIDTH = 620
ROW = 24                 # one instance
HEAD = 26                # the filter line
FOOT = 23                # the key hints
PAD = 8
MAX_ROWS = 12            # past this the panel is taller than it is useful; keep typing

NUM_X, STATE_X, AGE_X, PATH_X, SUM_X = 10, 28, 84, 126, 330
HINTS = "1-0/enter jump   esc close"

# ------------------------------------------------------------------------- the icon

ICON = 18                # square, inside the menu bar's 22pt, with room to breathe
MIN_GRID = 2             # 2x2 is the smallest; one dot filling the icon is a blob
FILL = 0.62              # how much of its cell a dot takes across
WAIT_FILL = 0.80         # except a `wait` dot, which is bigger so it is the one you see


def icon_dots(states, box=ICON):
    """Where a dot per state goes in a `box`-sized square, as (cx, cy, r), cy from the top.

    One dot per instance, in the smallest square grid that holds them all. Three instances
    make a 2x2 with a hole in it, five a 3x3, so the shape of the icon is the count and
    the colors are what those sessions are doing. 2x2 is the floor: the box is a fixed
    size whatever the grid, so a lone instance in a 1x1 would draw one huge ball.

    What is centered in the box is the block of cells the dots use, not the whole grid and
    not each row on its own: the cells stay on one lattice, and the rows that have
    anything in them are centered as one rectangle. One dot sits dead center, two are a
    centered pair, three are a 2x2 with the last cell empty, five a row of three over the
    first two cells of the next row. Centering each row in itself instead would put the
    third dot under the middle of the pair, which reads as a triangle rather than as a
    grid with a hole. The cost is that a dot moves as sessions come and go, since the
    block changes size; the alternative was a fixed cell per dot, which parks the whole
    icon in a corner of the item whenever the grid is not full.

    A `wait` dot is drawn at 80% of its cell against everyone else's 62%, so it is bigger
    as well as brighter and the icon answers "does something want me" from the corner of
    an eye. As a fraction of the cell rather than a fixed bump, that is +0.81pt across a
    2x2 and +0.54 across a 3x3, and it can never grow into the dot beside it. It is the
    only reason this needs the states and not just how many there are.

    No states at all still gets one spot: nothing running needs something to click on, and
    the backends draw that one as an empty ring.

    cy grows downward, which is cairo's convention and the reverse of an unflipped
    AppKit view, so systray_mac flips it back.
    """
    shown = max(len(states), 1)
    grid = max(MIN_GRID, math.ceil(math.sqrt(shown)))
    cell = box / grid
    top = (box - math.ceil(shown / grid) * cell) / 2
    left = (box - min(shown, grid) * cell) / 2
    spots = []
    for n in range(shown):
        row, col = divmod(n, grid)
        fill = WAIT_FILL if n < len(states) and states[n] == "wait" else FILL
        spots.append((left + col * cell + cell / 2, top + row * cell + cell / 2,
                      cell * fill / 2))
    return spots


# ------------------------------------------------------------------------ the model

class Model:
    """The listing, the filter, the cursor, and what each key means.

    The three hooks are how it reaches back into a UI it knows nothing about: `redraw`
    when what is on screen has changed, `close` to put the panel away, `quit` to leave
    for good. A backend that only wants some of them passes lambdas for the rest.
    """

    def __init__(self, redraw=lambda: None, close=lambda: None, quit=lambda: None):
        self.clock = StateClock()
        self.instances, self.rows = [], []
        self.filter = ""
        self.selected = None       # the pid under the cursor, not the row number
        self.error = ""
        self.redraw, self.close, self.quit = redraw, close, quit

    # ---- the listing

    def poll(self):
        """One pass: relist, ring if anything woke up, and redraw."""
        self.instances = self.clock.update(discover())
        if self.clock.woke:                # busy -> wait: a turn ended or a prompt is up
            play()
        self.refresh()

    def refresh(self):
        """Re-rank against the filter and keep the cursor on something that exists."""
        self.rows = rank(self.instances, self.needle)
        shown = self.rows[:MAX_ROWS]
        if not any(i.pid == self.selected for i in shown):
            self.selected = shown[0].pid if shown else None
        self.redraw()

    @property
    def needle(self):
        """What is actually matched: the filter with its ends trimmed. A leading space is
        how you search for something starting with a digit, since a digit typed into an
        *empty* filter picks a row instead."""
        return self.filter.strip().lower()

    def match_marks(self, string):
        """Which characters of a field the filter matched, for the backend to pick out."""
        found = fuzzy(self.needle, string) if self.needle else None
        return found[1] if found else ()

    def states(self):
        """What the icon draws: every instance's state, in the order the rows go in.

        Rank order fills the grid, which puts every `wait` dot first: the icon is for
        telling you at a glance that something wants you, and reading an exact number off
        a menu bar or a status bar was never the point.
        """
        return [i.state for i in rank(self.instances)]

    # ---- what the panel says

    def counter(self):
        """The head line's right-hand count, and its color. Gold when something waits."""
        waiting = sum(i.state == "wait" for i in self.instances)
        if self.filter:
            return f"{len(self.rows)} of {len(self.instances)}", MAUVE
        return f"{waiting}/{len(self.instances)}", GOLD if waiting else MAUVE

    def empty(self):
        """What stands in for the rows when there are none."""
        return "no claude instances" if not self.instances else "nothing matches"

    def note(self):
        """The foot line's left half: something that went wrong, or what got cut off."""
        if self.error:
            return self.error, ERROR
        if len(self.rows) > MAX_ROWS:
            return f"+{len(self.rows) - MAX_ROWS} more, keep typing", DIM
        return "", DIM

    def height(self):
        """How tall the panel has to be for what it is currently showing."""
        rows = min(max(len(self.rows), 1), MAX_ROWS)
        return PAD + HEAD + rows * ROW + FOOT + PAD

    # ---- the cursor and the jump

    def opened(self):
        """Called every time the panel comes up: a fresh filter and no stale error."""
        self.filter, self.error = "", ""
        self.refresh()

    def selected_row(self):
        return next((n for n, i in enumerate(self.rows) if i.pid == self.selected), 0)

    def move(self, delta):
        if not self.rows:
            return
        row = min(max(self.selected_row() + delta, 0), min(len(self.rows), MAX_ROWS) - 1)
        self.selected = self.rows[row].pid
        self.redraw()

    def jump_row(self, row):
        """Focus that instance and put the panel away.

        Unlike the TUI, jumping closes: this is a launcher you called up to leave, not a
        window you are already sitting in. A jump that failed says so instead of closing,
        since a panel that vanished having done nothing is indistinguishable from one that
        worked.
        """
        if not 0 <= row < len(self.rows):
            return
        self.selected = self.rows[row].pid
        if err := jump(self.rows[row]):
            self.error = err
            self.redraw()
            return
        self.close()

    # ---- the keyboard

    def key(self, name="", char=""):
        """One keystroke. `name` is set for the keys that are not text, `char` otherwise.

        A digit typed into an *empty* filter picks that row. Once the filter has anything
        in it a digit is just another filter character, and a leading space is how you
        search for something that starts with one. Escape only closes the panel, so
        "quit" (which a backend maps from whatever means leave-for-good on its platform)
        is the one key that ends the process.
        """
        if name == "escape":
            self.close()
        elif name == "quit":
            self.quit()
        elif name == "enter":
            self.jump_row(self.selected_row())
        elif name == "backspace":
            self.filter = self.filter[:-1]
            self.refresh()
        elif name in ("down", "up"):
            self.move(1 if name == "down" else -1)
        elif not self.filter and len(char) == 1 and char in NUMBERS:
            self.jump_row(NUMBERS.index(char))
        elif char and char.isprintable():
            self.filter += char
            self.refresh()
