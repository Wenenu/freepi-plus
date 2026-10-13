// In-process flags shared between the extensions (a module rather than an env
// var: these are only ever about *this* process, and a test can reset them).
//
// They are also the only channel a rotation has to the session it is about to
// create: the extension instance that calls `ctx.newSession()` is torn down
// before the replacement is bound (the SDK makes captured `pi`/ctx stale), so
// the new instance — which does get a fresh `session_start` — reads the handoff
// from here.
export const runtimeFlags = {
  /** A rotation has asked for its handoff document and is waiting for it. */
  rotationPending: false,
  /**
   * The provider/model the *next* session must start on, set by a rotation just
   * before it replaces itself and applied (through the checked switch, never by
   * writing `ctx.model`) by the new session's own `session_start`. Without this
   * the handoff record said "antseed" while the new session quietly ran on
   * free-pi's default model.
   */
  pendingModel: null as { provider: string; model: string } | null,
  /**
   * The four-sentence brief the replaced session left behind, injected into the
   * new session's system prompt for its whole life. Same channel and same reason
   * as `pendingModel`: the instance that has it is stale by the time the
   * replacement exists.
   */
  pendingBrief: null as string | null,
};
