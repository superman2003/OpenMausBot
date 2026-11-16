import { channelQueueItem, completeChannelMessage, queueChannelMessage } from "../channel-queue.ts";
import type { DirectSendInput } from "../direct-send.ts";
import type { SideJobText } from "../side-jobs.ts";
import { completeSteeredMessage, isSteeredMessageQueued, queueSteeredMessage } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { createWorkConversation } from "../work-conversation.ts";

export type RoomConversationInput = Pick<DirectSendInput, "text" | "threadId" | "replyTo" | "sendId" | "sender" | "trigger" | "mentions"> & { groupId: string };

export function createWorkConversations(deps: {
  store: Store;
  writer(botId: string, threadId: string, trigger: UsageTrigger): SideJobText | null;
  roomBot(input: RoomConversationInput): BotRecord | undefined;
  status(threadId: string): unknown;
  notice(threadId: string, kind: "queued" | "failed"): string;
  settled(): void;
}) {
  const { store } = deps;
  const conversation = createWorkConversation({
    messages: threadId => store.activePath(threadId),
    status: deps.status, notice: deps.notice, settled: deps.settled,
    exists: (botId, threadId) => {
      const group = store.groupByThread(threadId);
      return group ? group.memberIds.includes(botId) && Boolean(store.bot(botId)) : Boolean(store.taskByThread(botId, threadId));
    },
    append: (threadId, message) => store.appendMessage(threadId, { ...message, workChat: true }),
  });

  return {
    pending: conversation.pending,
    cancel: conversation.cancel,
    direct(input: DirectSendInput, prompt: string): Message | null {
      const bot = store.bot(input.botId);
      if (!bot) return null;
      return conversation.start({
        bot, threadId: input.threadId, writer: deps.writer(bot.id, input.threadId, input.trigger),
        reserve: () => {
          let message!: Message;
          const queued = queueSteeredMessage(bot.id, input.threadId, input.text, {
            prompt, sendId: input.sendId, replyToId: input.replyTo?.id, sender: input.sender, trigger: input.trigger, mentions: input.mentions,
            record: queueId => {
              message = store.appendMessage(input.threadId, { role: "user", kind: "text", text: input.text, replyToId: input.replyTo?.id, sendId: input.sendId, queueId, sender: input.sender, workChat: true });
              return message.id;
            },
          });
          return { message, pending: () => isSteeredMessageQueued(bot.id, input.threadId, queued.id), complete: () => { completeSteeredMessage(bot.id, queued.id, input.threadId); } };
        },
      });
    },
    room(input: RoomConversationInput): Message | null {
      const bot = deps.roomBot(input);
      if (!bot) return null;
      return conversation.start({
        bot, threadId: input.threadId, writer: deps.writer(bot.id, input.threadId, input.trigger),
        from: { botId: bot.id, name: bot.name, color: bot.color },
        reserve: () => {
          let message!: Message;
          const queued = queueChannelMessage(input.groupId, input.threadId, input.text, {
            sendId: input.sendId, replyToId: input.replyTo?.id, sender: input.sender, trigger: input.trigger, mentions: input.mentions,
            record: queueId => {
              message = store.appendMessage(input.threadId, { role: "user", kind: "text", text: input.text, replyToId: input.replyTo?.id, sendId: input.sendId, queueId, channelMode: "chat", sender: input.sender, workChat: true });
              return message.id;
            },
          });
          return { message, pending: () => Boolean(channelQueueItem(input.groupId, queued.id)), complete: () => { completeChannelMessage(input.groupId, queued.id); } };
        },
      });
    },
  };
}
