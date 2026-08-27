// Pure file-transfer model contracts, shared by every lane that renders a batch.
//
// These types and this predicate used to live in `transfer-session.svelte.ts`
// alongside the legacy file lane. That lane is gone — the browser composes
// exactly one `link/1` transport now — but the SHAPES it defined are what the
// link's file lane, the workspace router and the surface all speak. Extracted
// here rather than moved into `mixed-file-session.svelte.ts` so the contract has
// no reactive state under it and no importer has to reach into a state machine
// to name a card on screen.

import type { FileMeta } from "./transfer";
import type { StatusKey } from "./i18n.svelte";

export interface Incoming {
  from: string;
  files: FileMeta[];
  total: number;
  /**
   * 上一次「接收」被用户在保存位置选择器里取消了，这张卡片是**重新问一次**。
   *
   * 只有桌面会出现（手机不开选择器）。置位的前提是这次取消**没有**在线路上留下
   * 任何东西：发送端仍停在 waitingAccept，重新点「接收」就是一次全新的用户手势、
   * 一次全新的选择器。界面据此换一句话，否则用户点了取消之后只会看到卡片原地
   * 不动，不知道自己还能不能再来一次。
   */
  retry?: boolean;
}

export interface Xfer {
  peer: string;
  dir: "send" | "recv";
  files: FileMeta[];
  index: number; // current file (0-based)
  sent: number; // plaintext bytes done across the batch
  total: number; // plaintext bytes total
  status: StatusKey; // translated at render time so it follows the language switch
  done: boolean;
  ok: boolean;
  speed: number; // bytes/sec
}

/**
 * 这一块写下去会不会超出 manifest 为该文件声明的大小。
 *
 * 单独提出来是为了能被测到：调用点在接收管道的闭包深处，那里没法直接构造。
 * `declared` 为 undefined 表示这个下标在 manifest 里根本不存在（发送端多发了一个
 * 文件），按 0 处理——任何字节都算越界。
 */
export function wouldExceedDeclared(declared: number | undefined, offset: number, chunkLen: number): boolean {
  return offset + chunkLen > (declared ?? 0);
}
