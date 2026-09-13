// A stand-in for `relayium-update-helper.exe`, speaking the real frame protocol.
//
// It exists so the HOST half is executed rather than merely type-checked: the
// framing, the payload-frame pairing, the sequencing and the refusal mapping in
// `native-scope.ts` are exercised here on any platform. It implements no
// custody — every answer is scripted — so nothing about it argues that the
// Windows implementation works.
import { appendFileSync, readFileSync } from "node:fs";

const KIND_JSON = 0x4a;
const KIND_BYTES = 0x42;
const script = JSON.parse(readFileSync(process.argv[2], "utf8"));

let buffer = Buffer.alloc(0);
let pendingBytes = 0;

function write(kind, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.byteLength, 0);
  header[4] = kind;
  process.stdout.write(Buffer.concat([header, payload]));
}

function answer(request) {
  // Every op is recorded, so a test can assert what was NOT sent — a marker no
  // amount of reasoning about the host's control flow can replace.
  if (script.opsLog) appendFileSync(script.opsLog, request.op + "\n");
  const rule = script.replies[request.op];
  if (rule === undefined) {
    write(KIND_JSON, Buffer.from(JSON.stringify({ ok: false, code: "protocol" })));
    return;
  }
  if (rule.bytes !== undefined) {
    // `announce` lets a test claim one length and send another, which is the
    // malformed case the host must refuse rather than accept.
    const body = rule.body !== undefined ? Buffer.from(rule.body) : Buffer.alloc(rule.bytes, rule.fill ?? 0x6a);
    const announced = rule.announce ?? body.byteLength;
    write(KIND_JSON, Buffer.from(JSON.stringify({ ...rule.reply, bytes: announced })));
    write(KIND_BYTES, body);
    return;
  }
  if (rule.raw !== undefined) {
    // A frame this host should refuse outright: an unknown kind, an oversized
    // control frame, or a reply that is not an object.
    write(rule.raw.kind ?? KIND_JSON, Buffer.alloc(rule.raw.length ?? 0, rule.raw.fill ?? 0x41));
    return;
  }
  if (rule.silent === true) return;
  if (rule.delayMs !== undefined) {
    // Held deliberately, so a test can abort while the request is KNOWN to be
    // in flight rather than hoping to win a race.
    setTimeout(() => write(KIND_JSON, Buffer.from(JSON.stringify(rule.reply))), rule.delayMs);
    return;
  }
  write(KIND_JSON, Buffer.from(JSON.stringify(rule.reply)));
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.byteLength < 5) return;
    const length = buffer.readUInt32BE(0);
    const kind = buffer[4];
    if (buffer.byteLength < 5 + length) return;
    const payload = buffer.subarray(5, 5 + length);
    buffer = buffer.subarray(5 + length);
    if (kind === KIND_BYTES) {
      // The payload of the write whose header arrived immediately before.
      if (payload.byteLength !== pendingBytes) {
        write(KIND_JSON, Buffer.from(JSON.stringify({ ok: false, code: "protocol" })));
        return;
      }
      pendingBytes = 0;
      write(KIND_JSON, Buffer.from(JSON.stringify({ ok: true })));
      continue;
    }
    const request = JSON.parse(payload.toString("utf8"));
    if (request.op === "custody.write") {
      // Answer only after its payload frame, exactly as the helper does.
      pendingBytes = request.bytes;
      continue;
    }
    answer(request);
  }
});
process.stdin.on("end", () => process.exit(0));
