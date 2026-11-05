/** Conservative support for un-frozen AMXD containers with a single JSON patch. */
type Box = { id: string; maxclass: string; text?: string; patching_rect?: number[]; [key: string]: unknown };
type Line = { source: [string, number]; destination: [string, number]; [key: string]: unknown };
export type PatcherDocument = { patcher: { boxes: { box: Box }[]; lines?: { patchline: Line }[]; [key: string]: unknown }; [key: string]: unknown };
type Device = { header: Buffer; document: PatcherDocument };
type Operation = { op: string; [key: string]: unknown };

export function decodeDevice(bytes: Buffer): Device {
  if (bytes.length < 33 || bytes.toString('ascii', 0, 4) !== 'ampf' || bytes.readUInt32LE(4) !== 4 || bytes.toString('ascii', 12, 16) !== 'meta' || bytes.readUInt32LE(16) !== 4 || bytes.toString('ascii', 24, 28) !== 'ptch') throw new Error('Unsupported AMXD container');
  const length = bytes.readUInt32LE(28);
  if (length !== bytes.length - 32 || bytes[bytes.length - 1] !== 0) throw new Error('Unsupported AMXD payload length or embedded resources');
  let document: PatcherDocument;
  try { document = JSON.parse(bytes.subarray(32, -1).toString('utf8')) as PatcherDocument; } catch { throw new Error('Invalid AMXD patch JSON'); }
  if (!document.patcher || !Array.isArray(document.patcher.boxes) || (document.patcher.lines !== undefined && !Array.isArray(document.patcher.lines))) throw new Error('Invalid patcher graph');
  return { header: Buffer.from(bytes.subarray(0, 32)), document };
}

export function encodeDevice(device: Device, document: PatcherDocument): Buffer {
  const payload = Buffer.from(JSON.stringify(document, null, 2) + '\0', 'utf8');
  const header = Buffer.from(device.header); header.writeUInt32LE(payload.length, 28);
  return Buffer.concat([header, payload]);
}

export function editPatcher(input: PatcherDocument, operations: Operation[]): PatcherDocument {
  if (!Array.isArray(operations) || operations.length > 100) throw new Error('Expected up to 100 operations');
  if (input.patcher.dependency_cache !== undefined && (!Array.isArray(input.patcher.dependency_cache) || input.patcher.dependency_cache.length > 0)) throw new Error('Devices with dependencies cannot be safely copied by this tool');
  // AMXD patchers are JSON documents; the Live Extension Host does not always
  // expose structuredClone even when the host's Node version supports it.
  const document = JSON.parse(JSON.stringify(input)) as PatcherDocument; const patch = document.patcher;
  patch.lines ??= [];
  const box = (id: unknown) => {
    const match = patch.boxes.find((v) => v.box.id === id)?.box;
    if (!match) throw new Error(`Missing object: ${String(id)}`);
    return match;
  };
  const position = (v: unknown) => {
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)) || v[2] <= 0 || v[3] <= 0) throw new Error('Invalid patching rectangle');
    return v as number[];
  };
  const port = (v: unknown) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1024) throw new Error('Invalid port'); return v; };
  for (const op of operations) {
    if (op.op === 'add') {
      if (typeof op.id !== 'string' || !op.id.trim() || patch.boxes.some((v) => v.box.id === op.id)) throw new Error('Duplicate or empty object ID');
      if (typeof op.maxclass !== 'string' || !op.maxclass.trim() || (op.text !== undefined && typeof op.text !== 'string')) throw new Error('Invalid object class or text');
      if (op.maxclass === 'newobj' && typeof op.text === 'string' && /^\s*expr~(?:\s|$)/i.test(op.text)) throw new Error('expr~ is not a supported top-level MSP object; use standard MSP objects such as *~, +~ and tanh~');
      const added: Box = { id: op.id, maxclass: op.maxclass, ...(op.text === undefined ? {} : { text: op.text as string }), patching_rect: position(op.rect) };
      if (op.maxclass === 'live.dial') {
        const name = op.parameter_name;
        const min = op.parameter_min ?? 0, max = op.parameter_max ?? 1, initial = op.parameter_initial ?? min;
        if (typeof name !== 'string' || !name.trim() || patch.boxes.some(({ box }) => box.varname === name)) throw new Error('Live dial requires a unique parameter_name');
        if (typeof min !== 'number' || typeof max !== 'number' || typeof initial !== 'number' || ![min, max, initial].every(Number.isFinite) || min >= max || initial < min || initial > max) throw new Error('Invalid Live dial parameter range or initial value');
        Object.assign(added, { numinlets: 1, numoutlets: 2, outlettype: ['', 'float'], parameter_enable: 1, varname: name, saved_attribute_attributes: { valueof: { parameter_type: 0, parameter_longname: name, parameter_shortname: name, parameter_linknames: 1, parameter_mmin: min, parameter_mmax: max, parameter_initial_enable: 1, parameter_initial: [initial] } } });
        const parameters = patch.parameters ?? {};
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Invalid patch parameter map');
        (parameters as Record<string, unknown>)[op.id] = [name, name, 0]; patch.parameters = parameters;
      }
      if (op.presentation_rect !== undefined && !(Array.isArray(op.presentation_rect) && op.presentation_rect.length === 0)) { added.presentation = 1; added.presentation_rect = position(op.presentation_rect); patch.openinpresentation = 1; }
      patch.boxes.push({ box: added });
    } else if (op.op === 'remove') {
      box(op.id); patch.boxes = patch.boxes.filter((v) => v.box.id !== op.id);
      patch.lines = patch.lines.filter(({ patchline }) => patchline.source[0] !== op.id && patchline.destination[0] !== op.id);
      if (patch.parameters && typeof patch.parameters === 'object' && typeof op.id === 'string') delete (patch.parameters as Record<string, unknown>)[op.id];
    } else if (op.op === 'set_text') {
      if (typeof op.text !== 'string') throw new Error('Invalid object text'); box(op.id).text = op.text;
    } else if (op.op === 'move') { box(op.id).patching_rect = position(op.rect);
    } else if (op.op === 'connect' || op.op === 'disconnect') {
      box(op.source); box(op.destination); const out = port(op.outlet); const inlet = port(op.inlet);
      const same = ({ patchline }: { patchline: Line }) => patchline.source[0] === op.source && patchline.source[1] === out && patchline.destination[0] === op.destination && patchline.destination[1] === inlet;
      const found = patch.lines.some(same);
      if (op.op === 'connect') { if (found) throw new Error('Duplicate connection'); patch.lines.push({ patchline: { source: [op.source as string, out], destination: [op.destination as string, inlet] } }); }
      else { if (!found) throw new Error('Missing connection'); patch.lines = patch.lines.filter((line) => !same(line)); }
    } else throw new Error(`Unsupported patch operation: ${op.op}`);
  }
  return document;
}
