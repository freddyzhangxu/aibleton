import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GridQuantization, type NoteDescription } from "@ableton-extensions/sdk";
import { gridLabel, gridStepBeats, snapNotesToGrid } from "./helpers.js";

const note = (start: number, extra?: Partial<NoteDescription>): NoteDescription => ({
  pitch: 60,
  startTime: start,
  duration: 0.25,
  velocity: 100,
  ...extra,
});

describe("gridStepBeats", () => {
  it("maps straight note-value grids to beats", () => {
    assert.equal(gridStepBeats(GridQuantization.Quarter, false), 1);
    assert.equal(gridStepBeats(GridQuantization.Eighth, false), 0.5);
    assert.equal(gridStepBeats(GridQuantization.Sixteenth, false), 0.25);
    assert.equal(gridStepBeats(GridQuantization.ThirtySecond, false), 0.125);
  });

  it("applies the 2/3 triplet factor to note-value grids", () => {
    assert.ok(Math.abs(gridStepBeats(GridQuantization.Eighth, true)! - 1 / 3) < 1e-9);
    assert.ok(Math.abs(gridStepBeats(GridQuantization.Quarter, true)! - 2 / 3) < 1e-9);
    assert.ok(Math.abs(gridStepBeats(GridQuantization.Half, true)! - 4 / 3) < 1e-9);
  });

  it("keeps bar-level grids straight even in triplet mode", () => {
    assert.equal(gridStepBeats(GridQuantization.Bar, true), 4);
    assert.equal(gridStepBeats(GridQuantization.TwoBars, true), 8);
  });

  it("returns null for NoGrid and unknown values", () => {
    assert.equal(gridStepBeats(GridQuantization.NoGrid, false), null);
    assert.equal(gridStepBeats(42, false), null);
    assert.equal(gridStepBeats(NaN, false), null);
  });
});

describe("gridLabel", () => {
  it("labels straight and triplet grids", () => {
    assert.equal(gridLabel(GridQuantization.Sixteenth, false), "1/16");
    assert.equal(gridLabel(GridQuantization.Eighth, true), "1/8T");
    assert.equal(gridLabel(GridQuantization.Bar, true), "1 bar");
    assert.equal(gridLabel(GridQuantization.NoGrid, false), "off");
  });
});

describe("snapNotesToGrid", () => {
  it("snaps starts to a straight 1/16 grid", () => {
    const out = snapNotesToGrid([note(0.13), note(0.9), note(1.0)], GridQuantization.Sixteenth, false);
    assert.deepEqual(out.map((n) => n.startTime), [0.25, 1, 1]);
  });

  it("snaps starts to a triplet 1/8 grid (1/3-beat steps)", () => {
    const out = snapNotesToGrid([note(0.3), note(1.4)], GridQuantization.Eighth, true);
    assert.ok(Math.abs(out[0].startTime - 1 / 3) < 1e-9);
    assert.ok(Math.abs(out[1].startTime - 4 / 3) < 1e-9);
  });

  it("preserves pitch, duration and velocity", () => {
    const out = snapNotesToGrid([note(0.13, { pitch: 36, duration: 0.7, velocity: 64 })], GridQuantization.Sixteenth, false);
    assert.equal(out[0].pitch, 36);
    assert.equal(out[0].duration, 0.7);
    assert.equal(out[0].velocity, 64);
  });

  it("leaves notes untouched when the grid is off", () => {
    const input = [note(0.13), note(1.37)];
    const out = snapNotesToGrid(input, GridQuantization.NoGrid, false);
    assert.deepEqual(out.map((n) => n.startTime), [0.13, 1.37]);
  });
});
