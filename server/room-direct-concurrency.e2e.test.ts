import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("waits for direct work before a room member executes", async () => {
  const gateDir = mkdtempSync(join(tmpdir(), "omb-room-direct-"));
  const gate = join(gateDir, "finish.gate");
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_MODE: "slow",
    FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
  });
  const { url } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as any;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as any;
    expect(response.ok, method + " " + path + ": " + JSON.stringify(result)).toBe(true);
    return result;
  };
  const fleet = async () => await api("GET", "/api/bots?messages=0") as any;
  const messages = async (threadId: string) => (await api("GET", "/api/threads/" + threadId + "/messages?limit=50")).messages as any[];
  const poll = { timeout: 30_000, interval: 100 };

  try {
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 2 } });
    const worker = (await control("new-bot", "--name", "Room Worker")).bot;
    await control("send", "--bot", worker.id, "--text", "Keep working on the private task");
    await expect.poll(async () => {
      const current = await fleet();
      return current.bots.find((bot: any) => bot.id === worker.id)?.tasks?.some((task: any) => task.busy) ?? false;
    }, poll).toBe(true);
    const directThreadId = (await fleet()).bots.find((bot: any) => bot.id === worker.id)?.tasks?.find((task: any) => task.busy)?.threadId;
    expect(directThreadId).toBeTruthy();

    const room = (await control("new-channel", "--name", "Dependent room", "--members", worker.id)).channel;
    const roomThreadId = room.activeTaskId as string;
    await control("send-channel", "--channel", room.id, "--text", "@Room Worker continue after the private task");

    await expect.poll(async () => (await messages(roomThreadId)).some(
      (message: any) => message.kind === "activity" && message.from?.botId === worker.id &&
        message.tool?.name?.includes("is finishing another conversation"),
    ), poll).toBe(true);
    expect((await fleet()).bots.find((bot: any) => bot.id === worker.id)?.tasks?.some((task: any) => task.busy)).toBe(true);
    expect((await messages(roomThreadId)).some(
      (message: any) => message.role === "bot" && message.kind === "text",
    )).toBe(false);

    writeFileSync(gate, "finish");
    await expect.poll(async () => (await fleet()).bots.find((bot: any) => bot.id === worker.id)?.tasks?.find(
      (task: any) => task.threadId === directThreadId,
    )?.busy, poll).toBe(false);
    await expect.poll(async () => (await messages(roomThreadId)).some(
      (message: any) => message.role === "bot" && message.kind === "text",
    ), poll).toBe(true);
    await expect.poll(async () => (await fleet()).groups.find((group: any) => group.id === room.id)?.tasks?.find(
      (task: any) => task.threadId === roomThreadId,
    )?.working, poll).toBe(false);
    const transcript = await messages(roomThreadId);
    expect(transcript.find((message: any) => message.tool?.name?.includes("is finishing another conversation"))?.tool?.ok).toBe(true);
    expect(transcript.some((message: any) => /skipped this round/i.test(message.tool?.name ?? ""))).toBe(false);
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, "finish");
    await fixture.close();
    rmSync(gateDir, { recursive: true, force: true });
  }
}, 120_000);
