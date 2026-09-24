---
name: dark-techno-kit
description: Build a focused dark techno drum kit and bassline in Ableton Live.
triggers:
  - dark techno
  - 暗黑 techno
  - techno drums
  - techno bass
---

## Goal
Create a dark, driving drum groove and bassline on the requested tracks. Follow the user's brief and current Live Set; treat the ideas below as starting points.

## Workflow
1. Inspect the Set and reuse suitable tracks or sounds when possible.
2. For a new drum group, use separate `Kick` and `Drums (No Kick)` MIDI tracks unless the user asks for one track. Load a dark techno kit with `load_drum_kit` on each track.
3. Start with a steady kick. Add restrained hats and percussion, then a low-passed bass pattern with rests that leave room for the kick.
4. Keep the pattern focused. A minor key, sparse tonal parts, and mostly closed hats are useful starting points, not requirements.

## Verify
- Use `get_clip_notes` to check the written MIDI.
- Use `analyze_song` to check that kick and bass have distinct roles.
- Summarize what changed and ask the user to audition it.
