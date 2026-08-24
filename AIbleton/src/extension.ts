import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { startServer } from "./server.js";

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

  context.commands.registerCommand("ai-assistant.open", () => {
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
  ] as const;
  for (const scope of scopes) {
    context.ui.registerContextMenuAction(scope, "Open", "ai-assistant.open");
  }
}
