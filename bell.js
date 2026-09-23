// The bell: macOS's Bottle.aiff, inlined, and the two ways to play it.

import {BYTES, MAC, sh} from "./sh.js";

// The first of these that is installed pipes BOTTLE to its stdin; nothing writes a file.
// In order of how little they do, and each argv ends in that player's own spelling of
// stdin: `paplay -` would open a file named `-`, so paplay gets nothing at all.
const PLAYERS = MAC ? [] : [
  ["pw-play", "-"],
  ["paplay"],
  ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-"],
];
let PLAYER = [];               // the first of PLAYERS that is installed, by loadBell()
let BELL = null;               // BOTTLE unpacked, by loadBell()
let RINGER = null;             // plays the system sound, set up on the first ring; macOS only

// sh() is async, so this runs once from loadBell() and not from play(), which a poll
// calls without awaiting. It was a sync call on a Promise until that broke Linux.
async function findPlayer() {
  for (const p of PLAYERS) {
    if ((await sh("sh", "-c", `command -v ${p[0]}`)).trim()) return p;
  }
  return [];
}

// What will make the sound, for doctor.
export function ringer() {
  return MAC ? "AudioServicesPlaySystemSound" : PLAYER.join(" ") || "(no player)";
}

// BOTTLE unpacked into the bytes of a WAV file. Async because Deno has no lzma and its
// only decompressor is DecompressionStream, a stream (gzip 3517 bytes against lzma's
// 3128). That is why it runs once at startup: play() comes from a poll that cannot await.
export async function loadBell() {
  if (BELL) return;
  PLAYER = await findPlayer();
  const packed = Uint8Array.from(atob(BOTTLE.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  const plain = new Uint8Array(await new Response(
    new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  // second differences: summing twice gets the samples back. A 185Hz tone barely moves
  // between samples, so they are small repeating numbers: 17640 bytes of PCM to 3128
  const deltas = new Int16Array(plain.buffer, plain.byteOffset, plain.length / 2);
  const pcm = new Int16Array(deltas.length);
  let run = 0, value = 0;
  for (let n = 0; n < deltas.length; n++) {
    run += deltas[n];
    value += run;
    pcm[n] = value;
  }
  BELL = wav(pcm);
}

// The 44 bytes of RIFF header in front of the samples.
function wav(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(44 + bytes.length);
  const v = new DataView(out.buffer);
  out.set(BYTES.encode("RIFF"), 0);
  v.setUint32(4, 36 + bytes.length, true);
  out.set(BYTES.encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);            // fmt chunk size
  v.setUint16(20, 1, true);             // PCM
  v.setUint16(22, 1, true);             // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);      // byte rate
  v.setUint16(32, 2, true);             // block align
  v.setUint16(34, 16, true);            // bits
  out.set(BYTES.encode("data"), 36);
  v.setUint32(40, bytes.length, true);
  out.set(bytes, 44);
  return out;
}

export function soundBytes() {
  return BELL ?? new Uint8Array(0);
}

const cstr = (s) => BYTES.encode(`${s}\0`);

/* Play wav as a system sound, which `systemsoundserverd` plays, not us.
 *
 * NOT AVAudioPlayer: that starts CoreAudio inside this process, and in the built app it
 * then sets up voice processing for the bundle id and asks TCC for the MICROPHONE, a real
 * prompt, on the first ring. An ad-hoc signature is a new identity on every build, so every
 * rebuild asked again. With a system sound no CoreAudio loads here and TCC is never asked.
 * The cost: it goes to the alert device at the alert volume, and it wants a file, which is
 * written once to a fixed path, not one per process.
 */
function ring(sound) {
  if (!RINGER) {
    const path = `${Deno.env.get("TMPDIR") ?? "/tmp/"}ccx-bell.wav`;
    let size = -1;
    try {
      size = Deno.statSync(path).size;
    } catch {
      // not there yet
    }
    if (size !== sound.length) Deno.writeFileSync(path, sound);
    const cf = Deno.dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFURLCreateFromFileSystemRepresentation: {
        parameters: ["pointer", "buffer", "isize", "bool"], result: "pointer"},
    }).symbols;
    const at = Deno.dlopen("/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox", {
      AudioServicesCreateSystemSoundID: {parameters: ["pointer", "buffer"], result: "i32"},
      AudioServicesPlaySystemSound: {parameters: ["u32"], result: "void"},
    }).symbols;
    const bytes = BYTES.encode(path);
    const url = cf.CFURLCreateFromFileSystemRepresentation(null, bytes, BigInt(bytes.length), false);
    const id = new Uint32Array(1);
    if (at.AudioServicesCreateSystemSoundID(url, new Uint8Array(id.buffer)) !== 0) return;
    RINGER = () => at.AudioServicesPlaySystemSound(id[0]);
  }
  RINGER();
}

// Ring the bell and return immediately; a no-op until loadBell() has run. The WAV is 17684
// bytes, under the 64KB a pipe holds, so the write cannot block on a player that is slow to
// start. Never wait on the player, it outlives the poll: .status.catch() only reaps it.
export function play() {
  if (!BELL) return;
  if (MAC) {
    try {
      ring(BELL);
    } catch {
      // no audio device, or a runtime that moved: silence beats a traceback on the TUI
    }
    return;
  }
  const cmd = PLAYER;
  if (!cmd.length) return;
  try {
    const child = new Deno.Command(cmd[0], {args: cmd.slice(1), stdin: "piped",
      stdout: "null", stderr: "null"}).spawn();
    const w = child.stdin.getWriter();
    w.write(BELL).then(() => w.close()).catch(() => {});
    child.status.catch(() => {});
  } catch {
    // nothing to play it with
  }
}

// macOS's /System/Library/Sounds/Bottle.aiff, cut to fit in a source file. To redo it:
//
//     afconvert -f WAVE -d LEI16@22050 -c 2 Bottle.aiff b.wav    # a real resampler
//     x = (left + right) / 2, cut to 0.40s, 40ms fade, round(x / 16) * 16
//     base64(gzip(second differences of x, as little-endian int16))
const RATE = 22050;
const BOTTLE = `
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
lPRbvnZwm5P7+nF13kNOrQpMjGcf2WLyOUdVtFTiHBS3eRSxis9AaleeSkCRvaoiSnLbbGG5Mspmzaq0OkMjztf4ukSepO9h
ypay1moUkOcjWCFSJVIFcI4F5tVBWjae4FVlNFfVGQyJxp6hb9IG8BTF5zrjWi4xR9mn3AduIa7lXlg9Q8m7nE19BgNFLtHS
Qet8R/s3z49KybRRR6jyKXiDR3JktHUWKEaXWo85B5XRUhdI6lmOVef87TM05dqGjR2flmeVls5X5XPd17R1qM441+Wvlj5b
59hK78STkzitk0Bce8gyd8UiZl29yByf10NcQmcy/PzkUPb90hbhZF7tM1e159T8tTktY02WRivWtiijiPVl7/OTZNk/9ypb
KFeZ0o7fnfzn6yBWOxh4smcrq+XSVmvraa8DrSgt97ta861niyd+WUugvN8+K9c64dbWa7mrWleY2JBlO47ip/+h0bb7ch+2
tYuKUOd62Izd70/1tWNEK460ziuW3n1u+VKadfSDt9+ldba8URc+qE2549rKm84jJZ6eGPncB1unFrCxV13v1UHTZlFE6a96
ADTP6WLD18+trmU/73dC2/Jsxdr6JPpZXDnj7ytza6+tn+vxM722vLglhXPPPD+HAnB+puazVbaO5/gl/bY1cDaDVmzF31gz
2rb8WfT/XBbf0/O7WZ3N5f3cWmujbmQL39fse11+Jfs4O5l9loN81vJsjPf2/HkW/rV1/6t++9UZfyWz+errTNPw5pQKfGOW
EbuBb2q7fvpTM34vgXfy+D3qiiEq+Jbnz2d8PuczPv+M/9/pXc9CF/9t8ftj1MjVn9H8GQv6Lp3ve9E/NYvf7fmnXvE3XjwX
RbZj/d4av2Z/Pxtz/o6M3+v6q0/fcfU+J//p1xnHP+XT3+X+J+b4tzz5/8F//339+/ra6782DRAM6EQAAA==`;
