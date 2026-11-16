import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("lets a room member answer while the same bot has direct work", async () => {
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

    const room = (await control("new-channel", "--name", "Concurrent room", "--members", worker.id)).channel;
    const roomThreadId = room.activeTaskId as string;
    await control("send-channel", "--channel", room.id, "--text", "@Room Worker answer in the room");

    await expect.poll(async () => {
      const current = await fleet();
      return current.groups.find((group: any) => group.id === room.id)?.tasks?.some(
        (task: any) => task.threadId === roomThreadId && task.working && task.busyBotId === worker.id,
      ) ?? false;
    }, poll).toBe(true);
    expect((await fleet()).bots.find((bot: any) => bot.id === worker.id)?.tasks?.some((task: any) => task.busy)).toBe(true);

    writeFileSync(gate, "finish");
    await expect.poll(async () => (await messages(directThreadId)).some(
      (message: any) => message.role === "bot" && message.kind === "text",
    ), poll).toBe(true);
    await expect.poll(async () => (await messages(roomThreadId)).some(
      (message: any) => message.role === "bot" && message.kind === "text",
    ), poll).toBe(true);
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, "finish");
    await fixture.close();
    rmSync(gateDir, { recursive: true, force: true });
  }
}, 120_000);
