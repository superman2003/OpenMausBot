import { afterEach, expect, it, vi } from "vitest";
import { createWorkConversation } from "./work-conversation.ts";
import type { BotRecord, Message } from "./store.ts";
import type { TextGenerationOptions } from "./contracts.ts";

afterEach(() => vi.useRealTimers());

function fixture() {
  let resolve!: (text: string) => void;
  const call = new Promise<string>(done => { resolve = done; });
  let pending = true;
  let exists = true;
  const message: Message = { id: "message", at: 1, role: "user", kind: "text", text: "How is the task going?" };
  const append = vi.fn();
  const settled = vi.fn();
  const complete = vi.fn(() => { pending = false; });
  const generateText = vi.fn((_prompt: string, _options?: TextGenerationOptions) => call);
  const conversation = createWorkConversation({
    messages: () => [message], status: () => ({ working: true }), exists: () => exists,
    append, notice: (_, kind) => kind, settled, timeoutMs: 100,
  });
  const start = () => conversation.start({
    bot: { id: "worker", name: "Worker", description: "video editor" } as BotRecord,
    threadId: "task", writer: { via: "engine", generateText },
    reserve: () => ({ message, pending: () => pending, complete }),
  });
  return { start, conversation, append, settled, complete, generateText, resolve, pending: () => pending, remove: () => { exists = false; } };
}

it("answers without delivering a read-only question as new work", async () => {
  const f = fixture();
  f.start();
  expect(f.conversation.pending("task")).toBe(true);
  f.resolve(JSON.stringify({ reply: "Still rendering.", needsWork: false }));
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.append).toHaveBeenCalledWith("task", expect.objectContaining({ text: "Still rendering.", replyToId: "message" }));
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.conversation.pending("task")).toBe(false);
});

it.each(["invalid JSON", JSON.stringify({ reply: "Done" }), JSON.stringify({ reply: "Change received", needsWork: true })])("retains a durable instruction if the reply cannot discharge it: %s", async raw => {
  const f = fixture();
  f.start();
  f.resolve(raw);
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.pending()).toBe(true);
  expect(f.complete).not.toHaveBeenCalled();
});

it("stops its own reply and suppresses a provider's late result", async () => {
  const f = fixture();
  f.start();
  f.conversation.cancel("other-task");
  expect(f.pending()).toBe(true);
  f.conversation.cancel("task");
  f.resolve(JSON.stringify({ reply: "Too late", needsWork: true }));
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.append).not.toHaveBeenCalled();
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.generateText.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("bounds a provider that ignores cancellation and leaves the message available to the work queue", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start();
  await vi.advanceTimersByTimeAsync(101);
  expect(f.conversation.pending("task")).toBe(false);
  expect(f.pending()).toBe(true);
  expect(f.append).toHaveBeenCalledWith("task", expect.objectContaining({ kind: "activity", tool: { name: "failed", ok: false } }));
  f.resolve(JSON.stringify({ reply: "Late", needsWork: false }));
  await vi.advanceTimersByTimeAsync(1);
  expect(f.append).toHaveBeenCalledTimes(1);
});

it("does not post into a deleted conversation", async () => {
  const f = fixture();
  f.start();
  f.remove();
  f.resolve(JSON.stringify({ reply: "Late", needsWork: false }));
  await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
  expect(f.append).not.toHaveBeenCalled();
});
