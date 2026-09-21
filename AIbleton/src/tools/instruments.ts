/** Melodic Live instruments that are useful for synth and bass parts. */
export const RANDOM_MELODIC_INSTRUMENTS = [
  "Analog",
  "Operator",
  "Wavetable",
  "Drift",
  "Meld",
  "Collision",
  "Tension",
] as const;

export type RandomMelodicInstrument = (typeof RANDOM_MELODIC_INSTRUMENTS)[number];

/**
 * Pick one instrument from the curated pool.
 * The optional RNG keeps boundary behavior deterministic in unit tests.
 */
export function pickRandomMelodicInstrument(rng: () => number = Math.random): RandomMelodicInstrument {
  const raw = Math.floor(rng() * RANDOM_MELODIC_INSTRUMENTS.length);
  const index = Math.min(
    RANDOM_MELODIC_INSTRUMENTS.length - 1,
    Math.max(0, raw),
  );
  return RANDOM_MELODIC_INSTRUMENTS[index];
}
