import type { ResolvedSender } from "../../shared/wire.ts";
import type { ChannelQueueItem } from "../channel-queue.ts";
import type { ReplyTarget } from "../replies.ts";
import type { RoomPick } from "../room-pointed.ts";
import type { Store } from "../store.ts";

export function appendRoomRequest(store: Pick<Store, "appendMessage" | "messagesFor" | "patchMessage">, input: {
  threadId: string;
  text: string;
  replyTo?: ReplyTarget;
  sendId?: string;
  channelMode: "chat" | "goal";
  queueId?: string;
  options: { queuedGroup?: ChannelQueueItem[]; via?: "api"; sender?: ResolvedSender; pointed?: RoomPick };
}) {
  const { threadId, text, replyTo, sendId, channelMode, queueId, options } = input;
  const queued = options.queuedGroup;
  if (queued?.length) {
    const appended = queued.map((item, index) => {
      const recorded = store.messagesFor(threadId).find(row => row.id === item.rowId || row.queueId === item.id && row.role === "user");
      if (recorded) return recorded.workChat ? store.patchMessage(threadId, recorded.id, { workChat: false })! : recorded;
      return store.appendMessage(threadId, {
        role: "user", kind: "text", text: item.text,
        replyToId: index === queued.length - 1 ? replyTo?.id : item.replyToId,
        reaction: item.reaction, sendId: item.sendId, channelMode: item.mode,
        queueId: item.id, via: item.via, sender: item.sender,
        ...(item.pointed ? { pointed: item.pointed.refs } : {}),
      });
    });
    return appended[appended.length - 1]!;
  }
  return store.appendMessage(threadId, {
    role: "user", kind: "text", text, replyToId: replyTo?.id,
    reaction: replyTo?.reactedWith, sendId, channelMode, queueId,
    via: options.via, sender: options.sender,
    ...(options.pointed ? { pointed: options.pointed.refs } : {}),
  });
}
