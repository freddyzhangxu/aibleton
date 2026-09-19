import type { ContextMenuScope } from "@ableton-extensions/sdk";

/**
 * One scope per right-click target kind. ArrangementSelection overlaps the
 * direct MIDI/Audio Clip scopes in Live's menu, so it is deliberately not
 * registered here.
 */
export const MENU_SCOPES = [
  "MidiTrack",
  "AudioTrack",
  "Scene",
  "MidiClip",
  "AudioClip",
  "ClipSlot",
  "DrumRack",
  "Simpler",
  "ClipSlotSelection",
] as const satisfies readonly ContextMenuScope<"1.0.0">[];
