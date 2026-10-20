import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { installTransportObserver, TRANSPORT_OBSERVER } from "../../web/e2e/android-transport-observer.mjs";

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sends = [];
  send(data) { if (this.failure) throw this.failure; this.sends.push(data); return "native-return"; }
}
class Peer extends EventTarget {
  connectionState = "new";
  iceConnectionState = "new";
  constructor(...args) { super(); this.args = args; }
  createDataChannel(...args) { this.channelArgs = args; return new Channel(); }
}
const setup = () => {
  const scope = { RTCPeerConnection: Peer, performance: { now: () => 1 } };
  installTransportObserver(scope);
  return scope;
};
test("delegates native construction, channel arguments, payload identity and return", () => {
  const scope = setup(), config = { secret: "not-in-report" }, options = { ordered: true };
  const pc = new scope.RTCPeerConnection(config);
  assert(pc instanceof Peer);
  assert(pc instanceof scope.RTCPeerConnection);
  assert.equal(pc.args[0], config);
  const ch = pc.createDataChannel("private-label", options), bytes = new Uint8Array([9, 4, 1]);
  assert.equal(pc.channelArgs[1], options);
  assert.equal(ch.send(bytes), "native-return");
  assert.equal(ch.sends[0], bytes);
  assert.equal(scope.__androidTransport.connections[0].channels[0].sent, 1);
  assert(!JSON.stringify(scope.__androidTransport).includes("private-label"));
  assert(!JSON.stringify(scope.__androidTransport).includes("not-in-report"));
});
test("preserves thrown native error identity without copying its text", () => {
  const scope = setup(), pc = new scope.RTCPeerConnection(), ch = pc.createDataChannel("x");
  const error = new Error("private-payload"); ch.failure = error;
  assert.throws(() => ch.send("secret"), (caught) => caught === error);
  assert.equal(scope.__androidTransport.connections[0].channels[0].sendErrors, 1);
  assert(!JSON.stringify(scope.__androidTransport).includes("private-payload"));
  assert(!JSON.stringify(scope.__androidTransport).includes("secret"));
});
test("observes incoming channels once and retains terminal state after event cap", () => {
  const scope = setup(), pc = new scope.RTCPeerConnection(), ch = new Channel();
  for (let n = 0; n < 2; n++) {
    const event = new Event("datachannel"); event.channel = ch; pc.dispatchEvent(event);
  }
  for (let n = 0; n < 200; n++) ch.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(3) }));
  ch.readyState = "closed"; ch.dispatchEvent(new Event("close"));
  pc.connectionState = "failed"; pc.dispatchEvent(new Event("connectionstatechange"));
  assert.equal(scope.__androidTransport.events.length, 128);
  assert(scope.__androidTransport.dropped > 0);
  assert.equal(scope.__androidTransport.connections[0].channels.length, 1);
  assert.equal(scope.__androidTransport.connections[0].channels[0].received, 200);
  assert.equal(scope.__androidTransport.connections[0].channels[0].state, "closed");
  assert.equal(scope.__androidTransport.connections[0].state, "failed");
});
test("bounds connection and channel metadata while still returning native objects", () => {
  const scope = setup();
  for (let n = 0; n < 10; n++) {
    const pc = new scope.RTCPeerConnection();
    for (let c = 0; c < 12; c++) assert(pc.createDataChannel("x") instanceof Channel);
  }
  assert.equal(scope.__androidTransport.connections.length, 4);
  assert(scope.__androidTransport.connections.every((pc) => pc.channels.length === 8));
});

test("serialized browser injection has no module closure and keeps terminal events", () => {
  const scope = { RTCPeerConnection: Peer, performance: { now: () => 2 } };
  runInNewContext(TRANSPORT_OBSERVER, { window: scope });
  const pc = new scope.RTCPeerConnection();
  const ch = pc.createDataChannel("x");
  for (let n = 0; n < 200; n++) ch.send(new Uint8Array(1));
  pc.connectionState = "failed"; pc.dispatchEvent(new Event("connectionstatechange"));
  assert.equal(scope.__androidTransport.events.at(-1).state, "failed");
  assert.equal(scope.__androidTransport.events.length, 128);
});
