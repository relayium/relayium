// shouldConfirmBeforeSend gates the auto-send flow: in a cross-network code room
// a joining peer could be a code-guesser, so the sender must confirm before the
// queued files are sent. On LAN (no code) auto-send stays frictionless.
export function shouldConfirmBeforeSend(roomCode: string | null | undefined): boolean {
  return !!roomCode;
}
