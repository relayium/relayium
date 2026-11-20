import { expect, it, vi } from "vitest";
import { conversationRows, snapshotConversation, deleteConversationSnapshot } from "../../src/renderer/inbox/conversation.js";
import type { InboxNamedDeliveryView, InboxSentHistoryView } from "../../src/shared/ipc-contract.js";

const sent: InboxSentHistoryView = { id: "job-aa", peerID: "peer-a", createdAt: 30, kind: "text", body: null, bytes: 10, items: [], state: "queued" };
const file: InboxNamedDeliveryView = { taskID: "task-a", sourceDeviceID: "peer-a", receivedAt: 20, text: false, declared: 2, items: [{ name: "one.txt", size: 10 }] };
it("joins both directions by authenticated device ID, keeps partial files and isolates legacy attribution", () => {
  const rows = conversationRows([{ id: "message-a", taskID: "text-task", sourceDeviceID: "peer-a", receivedAt: 10, bytes: 10 }],
    [file, { ...file, taskID: "old-task", sourceDeviceID: undefined, receivedAt: 5 } as unknown as InboxNamedDeliveryView,
      { ...file, taskID: "text-task", text: true, items: [] }], [sent]);
  expect(rows.map((row) => row.id)).toEqual(["sent:job-aa", "files:task-a", "message:message-a", "files:old-task"]);
  expect(rows.filter((row) => row.peer === "peer-a")).toHaveLength(3);
  expect(rows.at(-1)?.peer).toBe("");
  expect(rows.filter((row) => row.unread)).toHaveLength(3);
  expect(conversationRows([{ id: "read", taskID: "read-task", sourceDeviceID: "peer-a", receivedAt: 10, bytes: 1, readAt: 20 }], [], []).every((row) => !row.unread)).toBe(true);
});
it("snapshot deletion never widens to deliveries that arrived during confirmation", async () => {
  const sentAction = vi.fn(async () => true); const deliveryAction = vi.fn(async () => true);
  const rows = [...conversationRows([], [file], [sent])];
  const snapshot = snapshotConversation(4, rows);
  rows.push(...conversationRows([], [{ ...file, taskID: "new-task" }], [{ ...sent, id: "job-bb" }]));
  expect(await deleteConversationSnapshot(snapshot, { epoch: () => 4, sent: sentAction, message: async () => true, delivery: deliveryAction })).toBe(true);
  expect(sentAction).toHaveBeenCalledWith(["job-aa"]); expect(deliveryAction).toHaveBeenCalledExactlyOnceWith("task-a");
});
it("refuses an old account snapshot and stops further deletion if the account moves mid-delete", async () => {
  const snapshot = snapshotConversation(4, conversationRows([], [file], [sent]));
  const remove = vi.fn(async () => true);
  expect(await deleteConversationSnapshot(snapshot, { epoch: () => 5, sent: remove, message: remove, delivery: remove })).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  let epoch = 4;
  expect(await deleteConversationSnapshot(snapshot, { epoch: () => epoch, sent: async () => { epoch = 5; return true; }, message: remove, delivery: remove })).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});
