/**
 * Context-menu actions live in the Extension Host, not the extension module.
 * Live can activate the same development extension more than once in that
 * Host, so registrations must replace their predecessors rather than stack.
 */

export type UnregisterContextMenuAction = () => Promise<void>;

export interface ContextMenuUi<Scope extends string> {
  registerContextMenuAction(
    scope: Scope,
    title: string,
    commandId: string,
  ): Promise<UnregisterContextMenuAction>;
}

export interface ContextMenuRegistrationManager<Scope extends string> {
  replace(ui: ContextMenuUi<Scope>, scopes: readonly Scope[], title: string, commandId: string): Promise<void>;
}

type Report = (message: string, error: unknown) => void;

/** Build an independent manager for tests or a deliberately isolated Host. */
export function createContextMenuRegistrationManager<Scope extends string>(
  report: Report = (message, error) => console.warn(message, error),
): ContextMenuRegistrationManager<Scope> {
  let cleanups: UnregisterContextMenuAction[] = [];
  let tail: Promise<void> = Promise.resolve();

  const replace = (ui: ContextMenuUi<Scope>, scopes: readonly Scope[], title: string, commandId: string) => {
    const run = tail.then(async () => {
      const oldCleanups = cleanups;
      cleanups = [];
      const oldResults = await Promise.allSettled(oldCleanups.map((cleanup) => Promise.resolve().then(cleanup)));
      for (const result of oldResults) {
        if (result.status === "rejected") report("AIbleton: failed to unregister an old context-menu action", result.reason);
      }

      const registered = await Promise.allSettled(
        scopes.map((scope) => ui.registerContextMenuAction(scope, title, commandId)),
      );
      cleanups = registered.flatMap((result) => {
        if (result.status === "fulfilled") return [result.value];
        report("AIbleton: failed to register a context-menu action", result.reason);
        return [];
      });
    });
    // `run` handles expected SDK failures internally; keep a fulfilled tail so
    // a future activation can always clean up and re-register.
    tail = run.catch((error) => report("AIbleton: context-menu lifecycle failed", error));
    return run;
  };

  return { replace };
}

const MANAGER_KEY = Symbol.for("aibleton.context-menu-registration-manager");

/** One manager per Extension Host process. `globalThis` survives module reloads. */
export function sharedContextMenuRegistrationManager<Scope extends string>(): ContextMenuRegistrationManager<Scope> {
  const host = globalThis as typeof globalThis & { [MANAGER_KEY]?: ContextMenuRegistrationManager<unknown & string> };
  if (!host[MANAGER_KEY]) host[MANAGER_KEY] = createContextMenuRegistrationManager<unknown & string>();
  return host[MANAGER_KEY] as ContextMenuRegistrationManager<Scope>;
}
