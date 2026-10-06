/**
 * Per-turn registry of devices the agent itself inserted. Replacing or
 * deleting one of these is self-correction within a creation flow — it
 * destroys nothing the user had — so it bypasses the user-wording delete
 * authorization in deleteauth.ts. Identity is the host-assigned handle id
 * (stable across chain reordering), never name or index, so a user's own
 * device can never match: its handle was never recorded.
 *
 * Residual risk, accepted: if the user manually undoes an agent insert in
 * Live while the task is still running, the stale id lingers until turn end;
 * if the host recycled that exact id onto a new user device within the same
 * turn, the bypass could match it. The window is seconds, requires concurrent
 * manual edits, and forget-on-delete covers every tool-driven destruction.
 */
import { toolState, type Ctx } from "../state.js";
import { deviceAt, deviceRefFrom, resolveTrack } from "./helpers.js";
import { chainDeviceAt, drumPadAt, drumRackAt } from "./drum-rack.js";

/** Defensive read of the SDK handle id; test fakes are plain objects without
 * a handle and simply never register. Accepts bigint (real host) or number. */
export function handleIdOf(device: unknown): string | undefined {
  const id = (device as { handle?: { id?: unknown } } | null | undefined)?.handle?.id;
  return typeof id === "bigint" || typeof id === "number" ? String(id) : undefined;
}

export function recordCreatedDevice(device: unknown): void {
  const id = handleIdOf(device);
  if (id !== undefined) toolState.activeCreatedDeviceHandles.add(id);
}

export function recordCreatedTrack(track: unknown): void {
  const id = handleIdOf(track);
  if (id !== undefined) toolState.activeCreatedTrackHandles.add(id);
}

export function forgetCreatedDevice(device: unknown): void {
  const id = handleIdOf(device);
  if (id !== undefined) toolState.activeCreatedDeviceHandles.delete(id);
}

export function forgetCreatedTrack(track: unknown): void {
  const id = handleIdOf(track);
  if (id !== undefined) toolState.activeCreatedTrackHandles.delete(id);
}

export function clearCreatedDevices(): void {
  toolState.activeCreatedDeviceHandles.clear();
}

export function clearCreatedTurnObjects(): void {
  clearCreatedDevices();
  toolState.activeCreatedTrackHandles.clear();
}

/** Only a track created/duplicated this turn qualifies. A renamed or edited
 * pre-existing track is never recorded and cannot match by name or index. */
export function targetIsAgentCreatedTrack(
  context: Ctx,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName !== "delete_track") return false;
  try {
    const ref = resolveTrack(context, input, "track_index");
    const id = handleIdOf(ref.track);
    return id !== undefined && toolState.activeCreatedTrackHandles.has(id);
  } catch {
    return false;
  }
}

/** True iff the delete/replace tool's actual target — re-resolved from the
 * live Set right now — is a device this turn's agent created. Fails closed:
 * any resolution error or a non-device tool returns false, and non-device
 * tools return before touching the song at all (the refusal must stay
 * target-resolution-free, see dispatcher.delete.test.ts). */
export function targetIsAgentCreatedDevice(
  context: Ctx,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  try {
    let device: unknown;
    switch (toolName) {
      case "delete_device": {
        const ref = resolveTrack(context, input, "track_index");
        device = deviceAt(context, ref.index, deviceRefFrom(input));
        break;
      }
      case "replace_device": {
        const ref = resolveTrack(context, input, "track_index");
        const sourceRef =
          typeof input.source_device_name === "string" && input.source_device_name.trim()
            ? input.source_device_name
            : input.source_device_index;
        device = deviceAt(context, ref.index, sourceRef);
        break;
      }
      case "delete_drum_pad_device": {
        const ref = resolveTrack(context, input, "track_index");
        const rack = drumRackAt(ref.track, input);
        const chain = drumPadAt(rack, input.pad_note);
        device = chainDeviceAt(chain, input);
        break;
      }
      default:
        return false;
    }
    const id = handleIdOf(device);
    return id !== undefined && toolState.activeCreatedDeviceHandles.has(id);
  } catch {
    return false;
  }
}

export function targetIsAgentCreatedObject(
  context: Ctx,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  return toolName === "delete_track"
    ? targetIsAgentCreatedTrack(context, toolName, input)
    : targetIsAgentCreatedDevice(context, toolName, input);
}
