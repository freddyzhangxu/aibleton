import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildTrackObservations } from "../track.js";
import {
  audioClip,
  audioFeatures,
  fourOnFloor,
  midiClip,
  rolesOf,
  snapshot,
  stateWithAudio,
  track,
} from "./fixtures.js";

/** 32-beat arrangement: kick + bass MIDI tracks audible throughout. */
function foundationSong(kickBeats: number, bassBeats: number) {
  return snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("k", fourOnFloor(1), { start: 0, duration: kickBeats }),
      ]),
      track(1, "Bass", "midi", [
        midiClip("b", fourOnFloor(1, 40), { start: 0, duration: bassBeats }),
      ]),
    ],
    { cuePoints: [{ time: 0, name: "A" }] },
  );
}

test("kick + bass at full activity → strong_rhythmic_foundation", () => {
  const features = buildMusicalFeatures(
    buildMusicState(foundationSong(32, 32)),
    rolesOf([0, "kick"], [1, "bass"]),
  );
  const obs = buildTrackObservations(features);
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["strong_rhythmic_foundation"],
  );
  const o = obs[0];
  assert.equal(o.trackId, "0");
  assert.equal(o.relatedTrackId, "1");
  assert.equal(o.strength, 1); // min(1, 1)
  assert.equal(o.confidence, undefined); // activeRatio is a raw fact
  assert.deepEqual(o.evidence, [
    { metric: "tracks[0].activeRatio", value: 1, relatedValue: 1 },
  ]);
});

test("'drums' role counts as the rhythmic side of the foundation", () => {
  const features = buildMusicalFeatures(
    buildMusicState(foundationSong(32, 32)),
    rolesOf([0, "drums"], [1, "bass"]),
  );
  assert.deepEqual(
    buildTrackObservations(features).map((o) => o.kind),
    ["strong_rhythmic_foundation"],
  );
});

test("below the activity gate → no foundation", () => {
  const features = buildMusicalFeatures(
    buildMusicState(foundationSong(32, 16)), // bass: 50% < 0.8
    rolesOf([0, "kick"], [1, "bass"]),
  );
  assert.deepEqual(buildTrackObservations(features), []);
});

test("no role labels (analysis never ran) → no track observations at all", () => {
  const features = buildMusicalFeatures(buildMusicState(foundationSong(32, 32)));
  assert.deepEqual(buildTrackObservations(features), []);
});

test("MIDI-only kick+bass: foundation but NO low-frequency claim (rule 1)", () => {
  const features = buildMusicalFeatures(
    buildMusicState(foundationSong(32, 32)),
    rolesOf([0, "kick"], [1, "bass"]),
  );
  assert.ok(features.tracks.every((t) => t.lowEnergy === undefined)); // precondition
  assert.ok(buildTrackObservations(features).every((o) => o.kind !== "low_frequency_co_activity"));
});

test("analyzed low end on both → low_frequency_co_activity with weakest-link confidence", () => {
  const lowEnd = audioFeatures({
    bands: { sub: 0.4, bass: 0.3, lowMid: 0.1, mid: 0.1, highMid: 0.05, high: 0.05 },
  });
  const snap = snapshot(
    [
      track(0, "Kick", "audio", [audioClip("k", { start: 0, duration: 32 })]),
      track(1, "Bass", "audio", [audioClip("b", { start: 0, duration: 32 })]),
    ],
    { cuePoints: [{ time: 0, name: "A" }] },
  );
  const state = stateWithAudio(snap, [
    { trackPos: 0, clipPos: 0, features: lowEnd },
    { trackPos: 1, clipPos: 0, features: lowEnd },
  ]);
  const features = buildMusicalFeatures(state, rolesOf([0, "kick"], [1, "bass"]));
  assert.equal(features.tracks[0].lowEnergy?.value, 0.7); // precondition: sub+bass
  const obs = buildTrackObservations(features);
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["strong_rhythmic_foundation", "low_frequency_co_activity"],
  );
  const co = obs[1];
  assert.equal(co.strength, 0.7); // weaker of the two low ends
  assert.equal(co.confidence, 1); // both clips fully analyzed
  assert.deepEqual(co.evidence, [
    { metric: "tracks[0].lowEnergy", value: 0.7, relatedValue: 0.7 },
    { metric: "tracks[0].activeRatio", value: 1, relatedValue: 1 },
  ]);
});

test("only one side analyzed → no co-activity claim", () => {
  const lowEnd = audioFeatures({
    bands: { sub: 0.4, bass: 0.3, lowMid: 0.1, mid: 0.1, highMid: 0.05, high: 0.05 },
  });
  const snap = snapshot(
    [
      track(0, "Kick", "audio", [audioClip("k", { start: 0, duration: 32 })]),
      track(1, "Bass", "audio", [audioClip("b", { start: 0, duration: 32 })]),
    ],
    { cuePoints: [{ time: 0, name: "A" }] },
  );
  const state = stateWithAudio(snap, [{ trackPos: 0, clipPos: 0, features: lowEnd }]);
  const features = buildMusicalFeatures(state, rolesOf([0, "kick"], [1, "bass"]));
  assert.ok(buildTrackObservations(features).every((o) => o.kind !== "low_frequency_co_activity"));
});
