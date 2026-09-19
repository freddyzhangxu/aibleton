import { DrumChain, DrumRack, type Device, type Track } from "@ableton-extensions/sdk";
import { matchByName, setParamValue, toNum } from "./helpers.js";

export function drumRackAt(track: Track<"1.0.0">, input: Record<string, unknown>): DrumRack<"1.0.0"> {
  const racks = track.devices.filter((d): d is DrumRack<"1.0.0"> => d instanceof DrumRack);
  if (!racks.length) throw new Error(`轨道「${track.name}」没有 Drum Rack`);
  if (typeof input.rack_name === "string" && input.rack_name.trim()) return matchByName(racks, input.rack_name, "Drum Rack");
  const index = Number(input.rack_index ?? 0);
  if (!Number.isInteger(index) || index < 0 || index >= racks.length) throw new Error(`Drum Rack 序号 ${String(input.rack_index)} 无效（共有 ${racks.length} 个）`);
  return racks[index];
}

export function drumPadAt(rack: DrumRack<"1.0.0">, note: unknown): DrumChain<"1.0.0"> {
  const midiNote = Number(note);
  if (!Number.isInteger(midiNote) || midiNote < 0 || midiNote > 127) throw new Error("pad_note 必须是 0–127 的 MIDI 音符");
  const chain = rack.chains.find((item) => toNum(item.receivingNote) === midiNote);
  if (!chain) throw new Error(`Drum Rack「${rack.name}」没有 MIDI note ${midiNote} 的 pad`);
  return chain;
}

export function chainDeviceAt(chain: DrumChain<"1.0.0">, input: Record<string, unknown>): Device<"1.0.0"> {
  if (typeof input.device_name === "string" && input.device_name.trim()) return matchByName(chain.devices, input.device_name, "pad 设备");
  const index = Number(input.device_index);
  if (!Number.isInteger(index) || index < 0 || index >= chain.devices.length) throw new Error(`pad 设备序号 ${String(input.device_index)} 无效`);
  return chain.devices[index];
}

export async function presentPad(rack: DrumRack<"1.0.0">, chain: DrumChain<"1.0.0">) {
  const [volume, pan, ...sends] = await Promise.all([
    chain.mixer.volume.getValue(), chain.mixer.panning.getValue(), ...chain.mixer.sends.map((send) => send.getValue()),
  ]);
  return {
    rack: rack.name, pad_note: toNum(chain.receivingNote), chain_index: rack.chains.indexOf(chain),
    devices: chain.devices.map((device, index) => ({ index, name: device.name })), volume, pan, sends,
  };
}

export async function presentPads(track: Track<"1.0.0">) {
  const racks = track.devices.filter((d): d is DrumRack<"1.0.0"> => d instanceof DrumRack);
  return await Promise.all(racks.map(async (rack, rack_index) => ({
    rack_index, rack: rack.name, pads: await Promise.all(rack.chains.map((chain) => presentPad(rack, chain))),
  })));
}

export { setParamValue };
