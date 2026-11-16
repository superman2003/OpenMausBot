import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("answers during sequential room and direct work, preserving dependencies and dispatching action updates once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-work-chat-"));
  const replies = join(dir, "replies.json");
  const replyLog = join(dir, "text.jsonl");
  const setReply = (reply: string, needsWork: boolean) => writeFileSync(replies, JSON.stringify({ WORK_CONVERSATION: JSON.stringify({ reply, needsWork }) }));
  setReply("The first task is still running. The next member is waiting for its result.", false);
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: replies, FAKE_CLAUDE_TEXT_LOG: replyLog }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const evidencePath = `${logPath}.work-conversation.json`;
  const commands: unknown[] = [];
  const cli = async (...args: string[]) => {
    const answer = await runControlOmb([...args, "--url", url]) as any;
    commands.push({ command: args, answer });
    return answer;
  };
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(url + path, { method, headers: { Origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json() as any;
    expect(response.ok, `${path}: ${JSON.stringify(answer)}`).toBe(true);
    commands.push({ method, path, body, answer });
    return answer;
  };
  const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const file = (name: string) => join(dataDir, name);
  const poll = { timeout: 30_000, interval: 100 };
  try {
    const first = (await cli("new-bot", "--name", "First")).bot;
    const second = (await cli("new-bot", "--name", "Second")).bot;
    const direct = (await cli("new-bot", "--name", "Direct")).bot;
    const room = (await cli("new-channel", "--name", "Ordered work", "--members", `${first.id},${second.id}`)).channel;
    const threadId = room.activeTaskId;
    const planPath = file("room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [first.id]: { turns: [
        { reply: "FIRST_TASK_RESULT", gateFile: file("first.gate"), readyFile: file("first.ready") },
        { reply: "CAPTIONS_ADDED", expectContextIncludes: ["ADD_CAPTIONS"] },
      ] },
      [second.id]: { reply: "SECOND_TASK_RESULT", expectContextIncludes: ["FIRST_TASK_RESULT"], gateFile: file("second.gate"), readyFile: file("second.ready") },
      [direct.id]: { turns: [
        { reply: "DIRECT_TASK_RESULT", gateFile: file("direct.gate"), readyFile: file("direct.ready") },
        { reply: "DIRECT_UPDATE_APPLIED", expectContextIncludes: ["DIRECT_ADD_CAPTIONS"] },
      ] },
    }));
    await cli("send-channel", "--channel", room.id, "--text", "@First @Second Do your steps in order");
    await expect.poll(() => existsSync(file("first.ready")), poll).toBe(true);
    expect(existsSync(file("second.ready"))).toBe(false);
    const question = { text: "STATUS_QUESTION: What is happening?", threadId, sendId: "status-question-1", converse: true };
    const sent = await api(`/api/groups/${room.id}/messages`, question);
    expect(sent.message).toMatchObject({ workChat: true, role: "user" });
    const retried = await api(`/api/groups/${room.id}/messages`, question);
    expect(retried.message.id).toBe(sent.message.id);
    await expect.poll(async () => (await messages(threadId)).some(row => row.workChat && row.role === "bot" && row.replyToId === sent.message.id && row.text?.includes("still running")), poll).toBe(true);
    expect(existsSync(file("first.gate"))).toBe(false);
    expect(existsSync(file("second.ready"))).toBe(false);
    const state = (await cli("channels")).channels.find((entry: any) => entry.id === room.id);
    expect(state.working).toBe(true);
    expect(readFileSync(replyLog, "utf8").trim().split("\n").filter(line => line.includes("WORK_CONVERSATION")).length).toBe(1);

    writeFileSync(file("first.gate"), "release");
    await expect.poll(() => existsSync(file("second.ready")), poll).toBe(true);
    const turns = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    setReply("I will add captions after the current work finishes.", true);
    const instruction = await api(`/api/groups/${room.id}/messages`, { text: "@First ADD_CAPTIONS", threadId, sendId: "action-update-001", converse: true });
    await expect.poll(async () => (await messages(threadId)).some(row => row.role === "bot" && row.replyToId === instruction.message.id && row.text?.includes("instruction is saved")), poll).toBe(true);
    expect(turns().filter(turn => turn.botId === first.id)).toHaveLength(1);
    writeFileSync(file("second.gate"), "release");
    await expect.poll(async () => (await messages(threadId)).some(row => row.text === "CAPTIONS_ADDED"), poll).toBe(true);
    expect((await cli("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
    const roomMessages = await messages(threadId);
    expect(roomMessages.filter(row => row.sendId === "status-question-1")).toHaveLength(1);
    expect(roomMessages.filter(row => row.sendId === "action-update-001")).toHaveLength(1);
    expect(roomMessages.find(row => row.sendId === "action-update-001").workChat).toBe(false);
    expect(turns().filter(turn => turn.botId === first.id)).toHaveLength(2);
    const secondTurn = turns().find(turn => turn.botId === second.id);
    expect(JSON.stringify(secondTurn.prompt)).toContain("FIRST_TASK_RESULT");
    expect(JSON.stringify(secondTurn.prompt)).not.toContain("STATUS_QUESTION");

    setReply("The direct task is still running; we can discuss it meanwhile.", false);
    await cli("send", "--bot", direct.id, "--text", "Do the direct task");
    await expect.poll(() => existsSync(file("direct.ready")), poll).toBe(true);
    const directState = (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === direct.id);
    const directThread = directState.threadId;
    const directSent = await api(`/api/bots/${direct.id}/messages`, { text: "Can we discuss the plan?", threadId: directThread, sendId: "direct-chat-00001", converse: true });
    expect(directSent.message.workChat).toBe(true);
    await expect.poll(async () => (await messages(directThread)).some(row => row.replyToId === directSent.message.id && row.text?.includes("discuss it meanwhile")), poll).toBe(true);
    expect(existsSync(file("direct.gate"))).toBe(false);
    expect((await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === direct.id).busy).toBe(true);
    setReply("I will update the direct task after it finishes.", true);
    const directUpdate = await api(`/api/bots/${direct.id}/messages`, { text: "DIRECT_ADD_CAPTIONS", threadId: directThread, sendId: "direct-update-0001", converse: true });
    await expect.poll(async () => (await messages(directThread)).some(row => row.replyToId === directUpdate.message.id && row.text?.includes("instruction is saved")), poll).toBe(true);
    writeFileSync(file("direct.gate"), "release");
    await expect.poll(async () => (await messages(directThread)).some(row => row.text === "DIRECT_UPDATE_APPLIED"), poll).toBe(true);
    expect((await cli("wait", "--bot", direct.id, "--timeout", "30")).status).toBe("settled");
    const directTurns = turns().filter(turn => turn.botId === direct.id);
    expect(directTurns).toHaveLength(2);
    expect(JSON.stringify(directTurns[1].prompt)).not.toContain("Can we discuss the plan?");
    expect((await messages(directThread)).filter(row => row.sendId === "direct-update-0001")).toHaveLength(1);
    writeFileSync(evidencePath, JSON.stringify({ url, logPath, commands, roomMessages, directMessages: await messages(directThread) }, null, 2));
    console.log(`work-conversation evidence: ${evidencePath}`);
  } finally {
    for (const name of ["first.gate", "second.gate", "direct.gate"]) writeFileSync(file(name), "release");
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
