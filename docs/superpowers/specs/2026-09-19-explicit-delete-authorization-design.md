# Explicit deletion authorization design

## Goal

Expose the public Extensions SDK deletion APIs without allowing a model, a
previous conversation turn, or YOLO mode to infer permission to delete.  A
deletion runs without an additional confirmation only when the current user
message explicitly requests deletion of the relevant kind of Live object.

## Scope

Add five agent tools:

- `delete_track`
- `delete_scene`
- `delete_device`
- `delete_arrangement_clip`
- `delete_session_clip`

Each calls its matching public SDK method: `Song.deleteTrack`,
`Song.deleteScene`, `Track.deleteDevice`, `Track.deleteClip`, or
`ClipSlot.deleteClip`.

This change does not add bulk deletion, deletion of return/master tracks,
take-lane editing, or undo automation.  Users retain Live Undo as the
recovery path.

## Authorization model

At the beginning of each chat request, the server derives a short-lived
`DeleteAuthorization` from that request's user text.  It is held only for the
active request and is cleared in the request's `finally` block.

The authorization is kind-specific.  It permits one or more of `track`,
`scene`, `device`, `arrangement_clip`, and `session_clip`; it never grants a
general write privilege.  It is granted only if the message contains an
unambiguous deletion verb (for example delete/remove/删/删除) and an explicit
object-kind reference.  Generic requests such as “clean this up”, “remove
unused things”, or “make it tidier” grant nothing.

Every delete tool calls the authorization guard before resolving or mutating a
Live object.  An absent authorization returns a structured bilingual error
that asks the user to explicitly name the kind of object to delete.  YOLO
does not bypass this guard.  A valid authorization skips the ordinary
Allow/Deny confirmation bar, matching the user-approved rule that an explicit
delete request needs no second confirmation.

## Tool behavior

All tools use the existing fresh-resolution conventions rather than holding
SDK handles across turns:

- Track operations accept `track_index` and the existing optional/paired
  `track_name`, resolving names again if indexes moved.
- Scene operations validate the current `scene_index` before deletion.
- Device operations resolve the current track, then `device_index` or
  `device_name` with the existing device helper.
- Arrangement clips resolve the current track, then validate an arrangement
  `clip_index` on that track.
- Session clips resolve the current MIDI or audio track and validate its
  `scene_index` / clip slot; an empty slot is rejected.

Successful results include the deleted object name, its original index, and
enough parent context to identify it in the chat log.  They also state that
the change can be reversed with Live Undo.  SDK errors leave the Set otherwise
unchanged and are normalized by the existing tool-error path.

## Confirmation and prompt integration

`callTool` treats a delete tool with valid `DeleteAuthorization` as already
approved for the confirmation-bar decision only.  It remains a mutating tool:
it consumes one mutation-budget slot, participates in the action log and
post-tool plumbing, and is not added to `READ_ONLY_TOOLS`.

The system prompt replaces its incorrect “cannot delete tracks or scenes”
statement with the authorization rule.  Tool descriptions make clear that
only an explicit current-turn user request permits deletion; the model must
ask a clarifying question for broad cleanup requests.

## Verification and tests

Add focused unit tests for the pure authorization parser and for the guard.
Add dispatcher tests with mock SDK objects covering:

1. each public deletion method is called once for a valid, current target;
2. stale track indexes re-resolve by track name;
3. invalid scene/device/clip indexes and an empty Session slot fail before an
   SDK mutation;
4. missing or wrong-kind authorization fails before target resolution;
5. delete tools remain mutating for the turn budget, while their valid
   authorization bypasses only the generic confirmation bar;
6. successful results retain the object identity and Live Undo guidance.

Run the complete TypeScript test suite and production type/build checks.

## Out of scope follow-ups

After this change, the next SDK capability to expose should be Session Audio
Clip creation (`ClipSlot.createAudioClip`).  Device duplicate/delete and warp
editing can be designed independently; only device deletion is included here
because it shares the authorization model.
