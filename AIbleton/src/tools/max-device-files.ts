import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { decodeDevice, editPatcher, encodeDevice } from './max-device.js';
import { validateMaxPatcher } from './max-validation.js';
import { mkdirOutsideSandbox, pathExists, readHomeBinary, resolveAbletonLibraryPaths } from '../paths.js';

function filePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.amxd') throw new Error(`${label} must be an absolute .amxd path`);
  return value;
}
async function findTemplate(kind: unknown): Promise<string> {
  const names: Record<string, string> = { audio_effect: 'Max Audio Effect.amxd', midi_effect: 'Max MIDI Effect.amxd', instrument: 'Max Instrument.amxd' };
  if (typeof kind !== 'string' || !names[kind]) throw new Error('kind must be audio_effect, midi_effect, or instrument');
  const app = process.execPath.match(/^(.+?\.app)\//)?.[1];
  const candidates = [app, '/Applications/Ableton Live 12 Suite.app', '/Applications/Ableton Live 12 Beta.app'].filter((v): v is string => Boolean(v));
  for (const root of candidates) {
    const candidate = path.join(root, 'Contents/App-Resources/Misc/Max Devices', names[kind]);
    if (pathExists(candidate)) return candidate;
  }
  throw new Error('Cannot locate Live template; provide template_path');
}
async function writeExclusive(destination: string, data: Buffer): Promise<void> {
  try { await fs.writeFile(destination, data, { flag: 'wx' }); return; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_ACCESS_DENIED') throw error;
  }
  // Live's installed host can deny direct filesystem access while allowing child processes.
  if (process.platform === 'win32') throw new Error('Live denied filesystem access; choose an accessible output location');
  const script = 'use Fcntl qw(O_WRONLY O_CREAT O_EXCL); binmode STDIN; sysopen(my $out, $ARGV[0], O_WRONLY|O_CREAT|O_EXCL, 0666) or exit($!{EEXIST} ? 17 : 1); binmode $out; while (read(STDIN, my $buf, 65536)) { print $out $buf or exit 1; } close($out) or exit 1;';
  try { execFileSync('/usr/bin/perl', ['-e', script, destination], { input: data, stdio: ['pipe', 'ignore', 'pipe'], timeout: 15000 }); }
  catch (error) { if ((error as { status?: number }).status === 17) { const e = new Error('File already exists') as NodeJS.ErrnoException; e.code = 'EEXIST'; throw e; } throw error; }
}

export async function maxDeviceFileTool(name: string, input: Record<string, unknown>, options?: { defaultDirectory?: string }): Promise<unknown> {
  const source = name === 'create_max_device' || name === 'inspect_max_template' ? (input.template_path ? filePath(input.template_path, 'template_path') : await findTemplate(input.kind)) : filePath(input.source_path, 'source_path');
  const data = readHomeBinary(source);
  if (!data) throw new Error(`Cannot read Max device: ${source}`);
  const device = decodeDevice(data);
  if (name === 'validate_max_device_file') return { source_path:source, validation:validateMaxPatcher(device.document, {expectAudioIO:device.header.toString('ascii',8,12)==='aaaa'}) };
  if (name === 'inspect_max_device_file' || name === 'inspect_max_template') {
    const patch = device.document.patcher;
    const offset = typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const lineOffset = typeof input.line_offset === 'number' && Number.isInteger(input.line_offset) && input.line_offset >= 0 ? input.line_offset : 0;
    const lines = patch.lines ?? [];
    return { source_path: source, object_count: patch.boxes.length, connection_count: lines.length, offset, line_offset: lineOffset,
      objects: patch.boxes.slice(offset, offset + 20).map(({ box }) => ({ id: box.id, maxclass: box.maxclass, text: typeof box.text === 'string' ? box.text.slice(0, 200) : undefined, patching_rect: box.patching_rect })),
      connections: lines.slice(lineOffset, lineOffset + 20).map(({ patchline }) => ({ source: patchline.source, destination: patchline.destination })),
      ...(offset + 20 < patch.boxes.length ? { next_offset: offset + 20 } : {}), ...(lineOffset + 20 < lines.length ? { next_line_offset: lineOffset + 20 } : {}) };
  }
  const operations = name === 'create_max_device' && input.operations === undefined ? [] : input.operations;
  if (!Array.isArray(operations)) throw new Error('operations must be an array');
  const edited = editPatcher(device.document, operations);
  const validation = validateMaxPatcher(edited, {expectAudioIO:device.header.toString('ascii',8,12)==='aaaa'});
  const content = encodeDevice(device, edited);
  let destination: string;
  if (input.output_path !== undefined && input.output_path !== '') {
    destination = filePath(input.output_path, 'output_path');
    await writeExclusive(destination, content);
  } else if (name === 'create_max_device' || name === 'edit_max_device_file') {
    const library = resolveAbletonLibraryPaths().userLibraries[0] ?? path.join(os.homedir(), 'Music', 'Ableton', 'User Library');
    const directory = name === 'edit_max_device_file' ? path.dirname(source) : options?.defaultDirectory ?? path.join(library, 'AIbleton', 'Max Devices');
    mkdirOutsideSandbox(directory);
    const rawName = name === 'edit_max_device_file' ? `${path.basename(source, path.extname(source))} - Edited` : typeof input.name === 'string' ? input.name.trim() : '';
    const baseName = (rawName.replace(/\.amxd$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '').slice(0, 100) || 'AIbleton Max Device');
    let written = false; destination = '';
    for (let i = 1; i <= 1000; i++) {
      destination = path.join(directory, `${baseName}${i === 1 ? '' : ` ${i}`}.amxd`);
      try { await writeExclusive(destination, content); written = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!written) throw new Error('Could not find an unused output filename');
  } else throw new Error('Unsupported Max device operation');
  return { created: destination, source_path: source, objects: edited.patcher.boxes.length, connections: edited.patcher.lines?.length ?? 0, validation, note: 'Static inspection only; open the new file in Max/Live to verify it. The loaded device was not modified.' };
}
