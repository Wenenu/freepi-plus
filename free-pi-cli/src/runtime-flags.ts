// In-process flags shared between the extensions (a module rather than an env
// var: these are only ever about *this* process, and a test can reset them).
export const runtimeFlags = {
  /** A rotation has asked for its handoff document and is waiting for it. */
  rotationPending: false,
};
