/** Test-only metadata: no payload, SDP, addresses, credentials or error text. */
export function installTransportObserver(scope) {
  const Native = scope.RTCPeerConnection;
  const report = { events: [], dropped: 0, connections: [] };
  scope.__androidTransport = report;
  const started = scope.performance.now();
  const note = (event) => {
    if (report.events.length === 128) { report.events.shift(); report.dropped++; }
    report.events.push({ ms: Math.round(scope.performance.now() - started), ...event });
  };
  if (!Native) return;
  scope.RTCPeerConnection = new Proxy(Native, {
    construct(Target, args, newTarget) {
      const pc = Reflect.construct(Target, args, newTarget);
      if (report.connections.length === 4) { note({ kind: "connection-limit" }); return pc; }
      const connection = { id: report.connections.length, state: pc.connectionState,
        ice: pc.iceConnectionState, channels: [] };
      report.connections.push(connection);
      const state = () => {
        connection.state = pc.connectionState;
        connection.ice = pc.iceConnectionState;
        note({ kind: "connection", connection: connection.id,
          state: connection.state, ice: connection.ice });
      };
      pc.addEventListener("connectionstatechange", state);
      pc.addEventListener("iceconnectionstatechange", state);
      state();
      const seen = new WeakSet();
      const watch = (channel) => {
        if (seen.has(channel)) return;
        seen.add(channel);
        if (connection.channels.length === 8) { note({ kind: "channel-limit" }); return; }
        const record = { id: connection.channels.length, state: channel.readyState,
          sent: 0, received: 0, sendErrors: 0 };
        connection.channels.push(record);
        const event = (kind, detail = {}) => note({ kind, connection: connection.id,
          channel: record.id, ...detail });
        const update = () => { record.state = channel.readyState; event("channel", { state: record.state }); };
        for (const name of ["open", "closing", "close", "error"]) channel.addEventListener(name, update);
        const size = (data) => {
          const value = data?.byteLength ?? data?.size;
          return Number.isSafeInteger(value) && value >= 0 ? value : null;
        };
        channel.addEventListener("message", ({ data }) => {
          record.received++;
          event("receive", { bytes: size(data), binary: typeof data !== "string" });
        });
        const send = channel.send;
        channel.send = function (...args) {
          try {
            const result = Reflect.apply(send, this, args);
            record.sent++;
            event("send", { bytes: size(args[0]), buffered: channel.bufferedAmount });
            return result;
          } catch (error) {
            record.sendErrors++;
            event("send-error", { state: channel.readyState });
            throw error;
          }
        };
        update();
      };
      const create = pc.createDataChannel;
      pc.createDataChannel = function (...args) {
        const channel = Reflect.apply(create, this, args);
        watch(channel);
        return channel;
      };
      pc.addEventListener("datachannel", ({ channel }) => watch(channel));
      return pc;
    },
  });
}

export const TRANSPORT_OBSERVER = `(${installTransportObserver.toString()})(window);`;
