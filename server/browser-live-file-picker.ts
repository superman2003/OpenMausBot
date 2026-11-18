import { randomUUID } from "node:crypto";
import type { Cdp, CdpEvent } from "./browser-sites.ts";

type PickerEvent =
  | { type: "fileChooser"; id: string; multiple: boolean; accept: string }
  | { type: "fileChooserClosed"; id: string };
type Controller = { id: string; send(event: PickerEvent): void };
type Input = { session: string; frame: string; node: number; multiple: boolean; accept: string | null };

export class LiveFilePicker {
  readonly #cdp: Cdp;
  #targets = new Map<string, Promise<unknown>>();
  #controller?: Controller;
  #input?: Input;
  #offer?: { id: string; controller: Controller };

  constructor(cdp: Cdp) {
    this.#cdp = cdp;
  }

  #intercept(session: string) {
    this.#targets.set(session, this.#cdp.send("Page.setInterceptFileChooserDialog", {
      enabled: Boolean(this.#controller),
    }, session).catch(() => undefined));
  }

  async ready() {
    await Promise.all(this.#targets.values());
  }

  control(controller?: Controller) {
    const previous = this.#controller;
    if (previous?.id === controller?.id) return;
    this.#controller = controller;
    if (Boolean(previous) !== Boolean(controller)) {
      for (const session of this.#targets.keys()) this.#intercept(session);
    }
    if (!controller) this.#input = undefined;
    this.#publish();
  }

  async event({ method, params, sessionId }: CdpEvent) {
    if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
      const type = (params.targetInfo as { type?: unknown } | undefined)?.type;
      if (type !== "page" && type !== "iframe") return;
      const session = params.sessionId;
      this.#intercept(session);
      if (type === "iframe") void this.#cdp.send("Page.enable", {}, session).catch(() => undefined);
      void this.#cdp.send("Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }, { exclude: true }],
      }, session).catch(() => undefined);
    } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      this.#targets.delete(params.sessionId);
      if (params.sessionId === this.#input?.session) this.#clear();
    } else if (method === "Page.frameNavigated" && this.#input?.session === sessionId) {
      const frame = params?.frame as { id?: unknown; parentId?: unknown } | undefined;
      if (!frame?.parentId || frame.id === this.#input?.frame) this.#clear();
    } else if (method === "Page.frameDetached" && this.#input?.session === sessionId && this.#input?.frame === params?.frameId) {
      this.#clear();
    } else if (method === "Page.fileChooserOpened" && this.#controller && sessionId && this.#targets.has(sessionId)
      && typeof params?.backendNodeId === "number" && typeof params.frameId === "string") {
      const input: Input = { session: sessionId, frame: params.frameId, node: params.backendNodeId, multiple: params.mode === "selectMultiple", accept: null };
      this.#clear();
      this.#input = input;
      const result = await this.#cdp.send("DOM.describeNode", { backendNodeId: input.node }, sessionId).catch(() => null);
      if (this.#input !== input) return;
      input.accept = "";
      const attributes = (result?.node as { attributes?: unknown } | undefined)?.attributes;
      if (Array.isArray(attributes)) {
        for (let i = 0; i < attributes.length; i += 2) {
          if (attributes[i] === "accept" && typeof attributes[i + 1] === "string") input.accept = attributes[i + 1].slice(0, 2048);
        }
      }
      this.#publish();
    }
  }

  offered(controller: string, id: string): boolean {
    return this.#offer?.id === id && this.#offer.controller.id === controller;
  }

  async answer(controller: string, id: string, paths: readonly string[]): Promise<boolean> {
    const input = this.#input;
    if (!input || !this.offered(controller, id) || (!input.multiple && paths.length > 1)) return false;
    await this.#cdp.send("DOM.setFileInputFiles", { backendNodeId: input.node, files: [...paths] }, input.session);
    if (this.#input === input) this.#clear();
    return true;
  }

  close() {
    this.#targets.clear();
    this.#controller = undefined;
    this.#clear();
  }

  #clear() {
    this.#input = undefined;
    this.#publish();
  }

  #publish() {
    const previous = this.#offer;
    this.#offer = undefined;
    previous?.controller.send({ type: "fileChooserClosed", id: previous.id });
    const controller = this.#controller;
    const input = this.#input;
    if (!controller || !input || input.accept === null || this.#offer) return;
    const id = randomUUID();
    this.#offer = { id, controller };
    controller.send({ type: "fileChooser", id, multiple: input.multiple, accept: input.accept });
  }
}
