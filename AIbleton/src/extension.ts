import { initialize, type ActivationContext, type ContextMenuScope } from "@ableton-extensions/sdk";
import { sharedContextMenuRegistrationManager } from "./menu-lifecycle.js";
import { startServer } from "./server.js";
import { setRightClickFocus, setSelectionContext } from "./setcontext.js";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // Start the assistant server immediately so the chat UI is also reachable
  // from a regular browser (non-modal, sits next to Live):
  //   http://localhost:17666/
  const serverReady = startServer(context)
    .then((server) => {
      console.log(`AI assistant: ${server.url} （也可以在浏览器中打开此地址）`);
      return server.url;
    })
    .catch((err) => {
      console.error("AI assistant server failed to start:", err);
      throw err;
    });

  context.commands.registerCommand("ai-assistant.open", (...args) => {
    // Context-menu scopes pass the clicked Live object's opaque Handle as the
    // first argument. Keep only that handle; setcontext.ts re-resolves it on
    // every chat turn so deleted objects cannot become stale prompt context.
    // Selection scopes pass a structured payload; object scopes pass a
    // Handle. The context module validates both forms and clears stale state.
    if (!setSelectionContext(context, args[0])) setRightClickFocus(context, args[0]);
    serverReady
      .then((url) => context.ui.showModalDialog(url, 460, 600))
      .catch(() => {});
  });

  // Beta 1 of the SDK only exposes context menus, so the dialog is triggered
  // by right-clicking tracks / scenes / clips.
  const scopes = [
    "MidiTrack",
    "AudioTrack",
    "Scene",
    "MidiClip",
    "AudioClip",
    "ClipSlot",
    "DrumRack",
    "Simpler",
    "ClipSlotSelection",
    "AudioTrack.ArrangementSelection",
    "MidiTrack.ArrangementSelection",
  ] as const;
  void sharedContextMenuRegistrationManager<ContextMenuScope<"1.0.0">>()
    .replace(context.ui, scopes, "Open", "ai-assistant.open")
    .catch((error) => console.error("AIbleton: context-menu registration failed:", error));
}
