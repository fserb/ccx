// The menu bar icon: one dot per instance, and the PNG encoder that draws it.
// Deno's tray takes PNG bytes and not a path, so nothing here writes a file.

const ICON = 18;            // square, inside the menu bar's 22pt, with room to breathe
const MIN_GRID = 2;         // 2x2 is the smallest; one dot filling the icon is a blob
const FILL = 0.62;          // how much of its cell a dot takes across
const WAIT_FILL = 0.80;     // except a `wait` dot, which is bigger so it is the one you see

// Not the panel's colors; the menu bar's background is the desktop. Luminance .58 and .26,
// both under the gold's .69. free is flat rather than translucent, so it survives a light
// bar, where a 45% white would vanish.
const DOTS = {wait: [0xff, 0xd5, 0x00], busy: [0xc8, 0xc8, 0xc8]};
const FREE = [0x8c, 0x8c, 0x8c];

const SS = 8;               // samples per pixel edge, so 64 levels of coverage on a rim
const RING = 1.2;           // pt, the stroke for the no-instances ring

// The API is not answering: a slash over whatever the dots say. White is the one thing in
// the icon above the gold by luminance, which the dots are ordered by; it is not a state,
// it is drawn over all of them, and it has to read against every one. ON A LIGHT MENU BAR
// IT DOES NOT: the line and the gap either side of it are both lighter than the dots, so on
// a light desktop the slash shows only as a break in them.
//
// The line is cleared before it is drawn, so it separates from a dot rather than merging
// with it; GAP is how wide that clearing is on each side.
const SLASH = [0xff, 0xff, 0xff];
const SLASH_W = 2.0;        // pt, the stroke: at 2.4, with a 1.1 gap, the two off-diagonal
const SLASH_GAP = 0.6;      // dots of a three-dot icon are left as crescents
const SLASH_PAD = 2.2;      // pt from the corners it runs between

// Where a dot per state goes in a `box`-sized square, as {cx, cy, r}, cy from the top. What
// is centered is the BLOCK OF CELLS THE DOTS USE, not the whole grid and not each row on
// its own: centering rows individually reads as a triangle, not a grid with a hole.
export function iconDots(states, box = ICON) {
  const shown = Math.max(states.length, 1);
  const grid = Math.max(MIN_GRID, Math.ceil(Math.sqrt(shown)));
  const cell = box / grid;
  const top = (box - Math.ceil(shown / grid) * cell) / 2;
  const left = (box - Math.min(shown, grid) * cell) / 2;
  const spots = [];
  for (let n = 0; n < shown; n++) {
    const row = Math.floor(n / grid), col = n % grid;
    const fill = states[n] === "wait" ? WAIT_FILL : FILL;
    spots.push({
      cx: left + col * cell + cell / 2,
      cy: top + row * cell + cell / 2,
      r: cell * fill / 2,
    });
  }
  return spots;
}

// Paint the ring between `inner` and `outer` radius, source-over, into an RGBA buffer; a
// disc is this with inner 0. Coverage is an SSxSS sample grid rather than an analytic area:
// at these sizes the difference is under a level of alpha. Only the dot's bounding box is
// walked, so the cost is the ink and not the canvas.
function stamp(rgba, px, cx, cy, outer, inner, color) {
  const o2 = outer * outer, i2 = inner * inner;
  const x0 = Math.max(0, Math.floor(cx - outer)), x1 = Math.min(px, Math.ceil(cx + outer) + 1);
  const y0 = Math.max(0, Math.floor(cy - outer)), y1 = Math.min(px, Math.ceil(cy + outer) + 1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - cx, dy = y + (sy + 0.5) / SS - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= o2 && d2 >= i2) hit++;
        }
      }
      if (hit) mix(rgba, (y * px + x) * 4, hit / (SS * SS), color);
    }
  }
}

// One pixel, `a` covered by `color`, or erased where `color` is null. Straight alpha, not
// premultiplied, which is what a PNG carries: an overlap is then a dimmer dot rather than a
// hole punched in the one underneath, and the hole is asked for explicitly.
function mix(rgba, at, a, color) {
  if (!color) {
    rgba[at + 3] = Math.round(rgba[at + 3] * (1 - a));
    return;
  }
  const [r, g, b] = color;
  const keep = (rgba[at + 3] / 255) * (1 - a);
  const out = a + keep;
  rgba[at] = Math.round((r * a + rgba[at] * keep) / out);
  rgba[at + 1] = Math.round((g * a + rgba[at + 1] * keep) / out);
  rgba[at + 2] = Math.round((b * a + rgba[at + 2] * keep) / out);
  rgba[at + 3] = Math.round(out * 255);
}

// The segment a..b as a `w`-wide stroke with round caps, or the hole one would leave where
// `color` is null. Coverage is sampled like stamp()'s, against the distance to the segment.
function stampSeg(rgba, px, a, b, w, color) {
  const r = w / 2, r2 = r * r;
  const vx = b.x - a.x, vy = b.y - a.y, vv = vx * vx + vy * vy;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r));
  const x1 = Math.min(px, Math.ceil(Math.max(a.x, b.x) + r) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r));
  const y1 = Math.min(px, Math.ceil(Math.max(a.y, b.y) + r) + 1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - a.x, dy = y + (sy + 0.5) / SS - a.y;
          const t = Math.max(0, Math.min(1, (dx * vx + dy * vy) / vv));
          const ex = dx - t * vx, ey = dy - t * vy;
          if (ex * ex + ey * ey <= r2) hit++;
        }
      }
      if (hit) mix(rgba, (y * px + x) * 4, hit / (SS * SS), color);
    }
  }
}

// Corner to corner, bottom left to top right, over everything already drawn.
function slash(rgba, px, scale) {
  const a = {x: SLASH_PAD * scale, y: px - SLASH_PAD * scale};
  const b = {x: px - SLASH_PAD * scale, y: SLASH_PAD * scale};
  stampSeg(rgba, px, a, b, (SLASH_W + 2 * SLASH_GAP) * scale, null);
  stampSeg(rgba, px, a, b, SLASH_W * scale, SLASH);
}

// The menu bar image for `states`, as PNG bytes at `scale` pixels per point. `offline` is
// the API not answering, which is a slash across the whole icon and not a state a dot has.
export function iconPng(states, scale = 2, offline = false) {
  const px = Math.round(ICON * scale);
  const rgba = new Uint8Array(px * px * 4);
  const spots = iconDots(states, px);
  states.forEach((state, n) => {
    const {cx, cy, r} = spots[n];
    stamp(rgba, px, cx, cy, r, 0, DOTS[state] ?? FREE);
  });
  if (!states.length) {     // nothing running still needs something to click on
    const {cx, cy, r} = spots[0];
    const w = Math.max(1, RING * scale);
    stamp(rgba, px, cx, cy, r + w / 2, r - w / 2, FREE);
  }
  if (offline) slash(rgba, px, scale);
  return png(px, px, rgba);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The CRC covers the type and the data together.
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(BYTES.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const BYTES = new TextEncoder();
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// `w` by `h` straight-alpha RGBA bytes as a PNG. IDAT wants a zlib stream, which is what
// "deflate" produces; "deflate-raw" omits the header and would make the file unreadable
// rather than throw.
export async function png(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  }
  const zipped = new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")));
  const idat = new Uint8Array(await zipped.arrayBuffer());

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8;              // bit depth
  ihdr[9] = 6;              // color type 6, RGBA; the last three stay 0
  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", idat),
                 chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
