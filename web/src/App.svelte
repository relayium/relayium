<script lang="ts">
  import { onMount } from "svelte";
  import {
    ready,
    generateKeyPair,
    deriveSession,
    sas,
    type KeyPair,
    type SessionKeys,
  } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { connect, type InboundSignal } from "./lib/webrtc";
  import { Sender, Receiver } from "./lib/transfer";
  import { createFileSink } from "./lib/filesink";
  import type { Peer } from "./lib/protocol";

  // Reactive state — Svelte 5 $state runes
  let status: string = $state("starting…");
  let sasCode: string = $state("");
  let progress: number = $state(0);
  let peers: Peer[] = $state([]);
  let selfId: string = $state("");

  // Non-reactive locals — set once in onMount, used in callbacks
  let selfKey: KeyPair;
  let signaling: SignalingClient;
  const activePeers = new Set<string>();

  // Derived — filters self out of the roster
  const visiblePeers = $derived(peers.filter((p) => p.id !== selfId));

  onMount(async () => {
    await ready();
    selfKey = generateKeyPair();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    signaling = new SignalingClient(
      `${proto}://${location.host}/ws`,
      deviceName(),
    );
    signaling.onSelfId((id) => (selfId = id));
    signaling.onPeers((p) => (peers = p));
    listenForIncoming();
    status = "ready";
  });

  function deviceName(): string {
    return `${navigator.platform || "device"}-${Math.floor(Math.random() * 1000)}`;
  }

  // RECEIVE — one offer-detector listener; per-peer signal routing is handled
  // inside connect() which registers its own filtered listener via onSignal().
  function listenForIncoming() {
    signaling.onSignal(async (from, data) => {
      const msg = data as InboundSignal;
      if (msg.sdp?.type !== "offer") return; // only act on offers
      if (activePeers.has(from)) return;      // already connecting to this peer
      activePeers.add(from);

      let keys: SessionKeys | undefined;
      const channel = await connect({
        signaling,
        peerId: from,
        selfKey: selfKey.publicKey,
        role: "responder",
        initialSignal: msg, // must be passed so the offer isn't lost
        onPeerKey: async (pk) => {
          keys = await deriveSession("responder", selfKey, pk);
          sasCode = sas(selfKey.publicKey, pk);
        },
      });

      while (!keys) await sleep(20);

      const receiver = new Receiver();
      let sink: Awaited<ReturnType<typeof createFileSink>> | undefined;
      let total = 0, got = 0;
      let pending: Promise<void> = Promise.resolve();
      const handleMessage = async (data: ArrayBuffer) => {
        const out = await receiver.feed(new Uint8Array(data), keys!);
        if (out.meta) { sink = await createFileSink(out.meta.name, out.meta.size); total = out.meta.size; }
        if (out.chunk && sink) { await sink.write(out.chunk); got += out.chunk.length; progress = total ? Math.round((got / total) * 100) : 0; }
        if (out.done && sink) { await sink.close(); status = out.done.ok ? "received ✓" : "INTEGRITY FAILED ✗"; }
      };
      channel.onmessage = (ev) => { pending = pending.then(() => handleMessage(ev.data as ArrayBuffer)); };
    });
  }

  // SEND — initiator path
  async function sendTo(peerId: string, file: File) {
    activePeers.add(peerId);
    let keys: SessionKeys | undefined;
    const channel = await connect({
      signaling,
      peerId,
      selfKey: selfKey.publicKey,
      role: "initiator",
      onPeerKey: async (pk) => {
        keys = await deriveSession("initiator", selfKey, pk);
        sasCode = sas(selfKey.publicKey, pk);
      },
    });

    while (!keys) await sleep(20);
    status = `verify code ${sasCode}, sending…`;

    const sender = new Sender();
    let sent = 0;
    for await (const frame of sender.frames(file, keys!)) {
      await backpressure(channel);
      channel.send(frame);
      sent += frame.byteLength;
      progress = Math.min(100, Math.round((sent / file.size) * 100));
    }
    status = "sent ✓";
  }

  // Helpers
  async function backpressure(ch: RTCDataChannel) {
    if (ch.bufferedAmount > ch.bufferedAmountLowThreshold) {
      await new Promise<void>((resolve) => {
        ch.onbufferedamountlow = () => {
          ch.onbufferedamountlow = null;
          resolve();
        };
      });
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) sendTo(peerId, file);
  }
</script>

<main>
  <h1>Relayium</h1>
  <p>
    status: {status}
    {#if sasCode}· code <b>{sasCode}</b>{/if}
  </p>
  {#if progress > 0}
    <progress value={progress} max="100"></progress>
    {progress}%
  {/if}
  <h2>Devices on your network</h2>
  {#if visiblePeers.length === 0}
    <p>No other devices yet. Open this page on another device on the same network.</p>
  {:else}
    <ul>
      {#each visiblePeers as p}
        <li
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => onDrop(e, p.id)}
        >
          {p.name}
          <input
            type="file"
            onchange={(e) => {
              const f = (e.currentTarget as HTMLInputElement).files?.[0];
              if (f) sendTo(p.id, f);
            }}
          />
        </li>
      {/each}
    </ul>
  {/if}
</main>
