// Who is making the current request (multi-user), without threading it through every call.
import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = { userId: string; username: string };
const als = new AsyncLocalStorage<Actor | undefined>();
export const withActor = <T>(actor: Actor | undefined, fn: () => T) => als.run(actor, fn);
export const currentActor = () => als.getStore();
