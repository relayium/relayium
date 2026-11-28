import type { InboxMessageView, InboxNamedDeliveryView, InboxSentHistoryView } from "../../shared/ipc-contract.js";

export type ConversationRow = { readonly unread: boolean } & (
  | { readonly id: string; readonly peer: string; readonly at: number; readonly kind: "message"; readonly message: InboxMessageView }
  | { readonly id: string; readonly peer: string; readonly at: number; readonly kind: "files"; readonly delivery: InboxNamedDeliveryView }
  | { readonly id: string; readonly peer: string; readonly at: number; readonly kind: "sent"; readonly sent: InboxSentHistoryView });

export function conversationRows(messages: readonly InboxMessageView[], named: readonly InboxNamedDeliveryView[], sent: readonly InboxSentHistoryView[]): readonly ConversationRow[] {
  const rows: ConversationRow[] = [
    ...messages.map((message) => ({ id: `message:${message.id}`, peer: message.sourceDeviceID, at: message.receivedAt, kind: "message" as const, message, unread: message.readAt === undefined })),
    ...named.filter((entry) => !entry.text).map((delivery) => ({ id: `files:${delivery.taskID}`, peer: delivery.sourceDeviceID ?? "", at: delivery.receivedAt, kind: "files" as const, delivery, unread: delivery.readAt === undefined })),
    ...sent.map((entry) => ({ id: `sent:${entry.id}`, peer: entry.peerID, at: entry.createdAt, kind: "sent" as const, sent: entry, unread: false })),
  ];
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** IDs copied at the time the user opens confirmation. No live list retained. */
export interface ConversationSnapshot {
  readonly epoch: number;
  readonly sent: readonly string[];
  readonly messages: readonly string[];
  readonly deliveries: readonly string[];
}
export function snapshotConversation(epoch: number, rows: readonly ConversationRow[]): ConversationSnapshot {
  return { epoch, sent: rows.flatMap((row) => row.kind === "sent" ? [row.sent.id] : []),
    messages: rows.flatMap((row) => row.kind === "message" ? [row.message.id] : []),
    deliveries: rows.flatMap((row) => row.kind === "files" ? [row.delivery.taskID] : []) };
}

/** Account changes stop the remaining deletes. Arrivals after the snapshot survive. */
export async function deleteConversationSnapshot(snapshot: ConversationSnapshot, actions: {
  epoch(): number;
  sent(ids: readonly string[]): Promise<boolean>;
  message(id: string): Promise<boolean>;
  delivery(id: string): Promise<boolean>;
}): Promise<boolean> {
  const alive = () => actions.epoch() === snapshot.epoch;
  if (!alive()) return false;
  if (snapshot.sent.length && !await actions.sent(snapshot.sent)) return false;
  for (const id of snapshot.messages) { if (!alive() || !await actions.message(id)) return false; }
  for (const id of snapshot.deliveries) { if (!alive() || !await actions.delivery(id)) return false; }
  return alive();
}

/** A display-only prefix. Null means the full text needs no disclosure. */
export function collapsedMessagePreview(text: string): string | null {
  let end = 0;
  let count = 0;
  let lines = 1;
  let previousWasCR = false;
  for (const scalar of text) {
    const point = scalar.codePointAt(0)!;
    const startsLine = ((point >= 0x0a && point <= 0x0d) || point === 0x85 || point === 0x2028 || point === 0x2029) &&
      !(previousWasCR && point === 0x0a);
    if (count === 160 || (startsLine && lines === 4)) return text.slice(0, end) + "…";
    if (startsLine) lines++;
    previousWasCR = point === 0x0d;
    end += scalar.length;
    count++;
  }
  return null;
}
