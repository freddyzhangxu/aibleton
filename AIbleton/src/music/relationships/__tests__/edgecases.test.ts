import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildMusicalRelationships } from "../index.js";
import { audioClip, densityShapeSong, snapshot, track } from "./fixtures.js";

test("empty project: no crash, no invented numbers", () => {
  const features = buildMusicalFeatures(buildMusicState(snapshot([])));
  const rel = buildMusicalRelationships(features);
  assert.deepEqual(rel.contrasts, []);
  assert.deepEqual(rel.similarities, []);
  assert.deepEqual(rel.arc, { energyCurve: [], energyCoverage: 0 });
});

test("single section: no pairs, arc kind undefined but peak present", () => {
  const rel = buildMusicalRelationships(densityShapeSong([4]));
  assert.deepEqual(rel.contrasts, []);
  assert.deepEqual(rel.similarities, []);
  assert.equal(rel.arc.kind, undefined);
  assert.equal(rel.arc.peakSectionId, "0");
});

test("all energy unknown: contrasts still ship on the density basis", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Pad", "audio", [
          audioClip("p1", { start: 0, duration: 32 }),
          audioClip("p2", { start: 32, duration: 32 }),
        ]),
      ],
      { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
    ),
  );
  const rel = buildMusicalRelationships(buildMusicalFeatures(state));
  assert.equal(rel.contrasts.length, 1);
  assert.equal(rel.contrasts[0].energyDelta, undefined);
  assert.equal(rel.contrasts[0].basis, "density");
  assert.equal(rel.contrasts[0].kind, "steady");
  assert.deepEqual(rel.arc, {
    energyCurve: [undefined, undefined],
    energyCoverage: 0,
  });
});

test("deterministic: identical features → identical relationships", () => {
  const features = densityShapeSong([1, 16, 1]);
  assert.deepEqual(buildMusicalRelationships(features), buildMusicalRelationships(features));
  // … and a rebuild from the same inputs agrees too.
  assert.deepEqual(buildMusicalRelationships(densityShapeSong([1, 16, 1])), buildMusicalRelationships(features));
});
