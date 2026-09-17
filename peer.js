// Delivering a chat message to a running instance, on the socket Claude Code's own
// sessions message each other over. All of it is undocumented internals, read out of the
// 2.1.273 binary; a changed frame would fail loudly, a changed meaning would not.

import { BYTES, HOME } from "./sh.js";

const SOCKS = "/tmp/cc-socks";
const SESSIONS = `${HOME}/.claude/sessions`;
const TIMEOUT = 2000;
const TAG = "cross-session-message";

// Who the message says it is from. Claude Code carries the sender's identity in the body
// and not in a frame field: the sender writes a `<cross-session-message>` envelope into
// `message.content`, and the receiver parses `from-name` back out of it. With no envelope
// the message still arrives, unattributed, looking like a prompt its own user typed.
//
// "user" because that is true. `ccx send` is someone at a terminal, not an agent.
export const SENDER = "user";

// `from` is deliberately absent: it is a reply address, and ccx has no socket to be replied
// to, so naming one would point at something that does not listen. `from-mode` likewise,
// since it tells the receiver which permission mode the sender is in and ccx is not in one.
// `from-name` is the part that gets displayed, and it is the only part we can answer for.
//
export function envelope(text) {
  return `<${TAG} from-name="${SENDER}">\n${text}\n</${TAG}>`;
}

// Whether this text is safe to put in an envelope, which it is not if it contains one.
// Passing it through bare does not help: the receiver parses the body's own envelope and
// believes its `from-name`, so `ccx send x '<cross-session-message from-name="root">...'`
// arrives from "root". A test asserts that, and it is why this refuses rather than strips.
// The realistic case is not an attack, it is a message quoting an envelope; the person
// typing it can see the error and rephrase, which no silent mangling would let them do.
export function forges(text) {
  return text.includes(TAG);
}

// The token authorising one socket sits in `<pid>.<sha256 of the socket path>.key`, over
// the path as the record writes it and NOT its realpath: /tmp is a symlink to /private/tmp
// on macOS, and hashing the resolved form names a file that does not exist. Checked
// against the four live sessions on this machine, all four exact.
async function keyPath(pid, sock) {
  const digest = await crypto.subtle.digest("SHA-256", BYTES.encode(sock));
  const hex = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${SESSIONS}/${pid}.${hex}.key`;
}

// The 32 hex characters of `peerToken`, or "" when the key file is unreadable. The file is
// 0600 and holds nothing else worth having: a token good only for delivering a line to one
// socket owned by this same user.
async function peerToken(pid, sock) {
  try {
    const key = JSON.parse(await Deno.readTextFile(await keyPath(pid, sock)));
    return key.peerToken ?? "";
  } catch {
    return "";
  }
}

// Deliver `text` to an instance as a chat message. Returns an error message, or null when
// it worked, the same shape jump() uses.
//
// The wire is one JSON object per line, and the auth frame goes first if it goes at all.
// It is only mandatory on Windows: the inbox sets `authRequired = requireAuth ?? (platform
// === "windows")` and nothing anywhere passes `requireAuth`, which occurs exactly twice in
// the 202MB binary, in an options schema and in that assignment. Sending it anyway, because
// that is a default and not a contract, and a release that flips it would otherwise break
// this silently. It buys an auth role and nothing else: `verifiedPeerPid` comes off the
// socket either way.
//
// There is no reply and no ack. The receiver answers on the sender's own socket, which ccx
// does not have, so delivered means the bytes were accepted, not that its Claude has read
// them; a session in a stricter permission mode holds the message for its user first.
export async function sendPeer(inst, text) {
  if (!text) return "nothing to send";
  if (forges(text)) return `a message may not contain a <${TAG}> envelope`;
  const sock = inst.sock || `${SOCKS}/${inst.pid}.sock`;
  const token = await peerToken(inst.pid, sock);
  if (!token) {
    return `${inst.pid}: no messaging key, so nothing to authenticate with`;
  }
  // a write blocks if the receiver stops reading, and the TUI calls this on the same task
  // as its input loop, so the whole exchange is raced and not the connect alone
  return await Promise.race([
    deliver(sock, token, text),
    new Promise((ok) =>
      setTimeout(() => ok(`${sock}: no answer in ${TIMEOUT}ms`), TIMEOUT)
    ),
  ]);
}

async function deliver(sock, token, text) {
  let conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: sock });
  } catch (e) {
    return `${sock}: ${e.message}`;
  }
  try {
    const line = (o) => conn.write(BYTES.encode(`${JSON.stringify(o)}\n`));
    await line({ type: "auth", token });
    await line({
      type: "user",
      // `priority` is one of now | next | later and anything else reads as next. `next`
      // queues the message the way a typed prompt queues, rather than cutting into a turn.
      priority: "next",
      msg_id: `cc-msg-${crypto.randomUUID().replaceAll("-", "")}`,
      message: { content: envelope(text) },
    });
  } catch (e) {
    return `${sock}: ${e.message}`;
  } finally {
    try {
      conn.close();
    } catch {
      // already gone
    }
  }
  return null;
}
