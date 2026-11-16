export interface MessageOrigin {
  /** User messages sent into a running turn (capabilities.queueing). */
  steered?: boolean;
  /** Chat beside an ongoing task. Kept out of execution context until a saved instruction is dispatched. */
  workChat?: boolean;
  /** User messages a peer bot handed to this thread's running turn: peer context folded in mid-turn, never a new request. The text is stored enveloped exactly as injected. */
  aside?: boolean;
  /** A user-role message that arrived through the server's HTTP API ("api"), or a request a person spoke on a Live call ("call"). */
  via?: "api" | "call";
  /** The Live call a "call" line was spoken on (LiveCallState.callId). Set only on user messages with `via: "call"`; a turn's own messages point at their request through `requestMessageId` instead. */
  callId?: string;
}
