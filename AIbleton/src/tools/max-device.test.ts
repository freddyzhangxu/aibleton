import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDevice, encodeDevice, editPatcher } from './max-device.js';
import { maxDeviceFileTool } from './max-device-files.js';

const document = { patcher: { boxes: [{ box: { id: 'a', maxclass: 'newobj', text: 'plugin~', patching_rect: [10, 20, 80, 22], extra: 'preserve' } }, { box: { id: 'b', maxclass: 'newobj', text: 'plugout~', patching_rect: [10, 120, 80, 22] } }], lines: [{ patchline: { source: ['a', 0], destination: ['b', 0] } }], other: { preserve: 1 } } };
function fixture() {
 const payload = Buffer.from(JSON.stringify(document) + '\0');
 const header = Buffer.alloc(32); header.write('ampf', 0); header.writeUInt32LE(4, 4); header.write('aaaa', 8); header.write('meta', 12); header.writeUInt32LE(4, 16); header.write('ptch', 24); header.writeUInt32LE(payload.length, 28);
 return Buffer.concat([header, payload]);
}

test('edits a device copy and preserves untouched metadata', () => {
 const original = fixture(); const device = decodeDevice(original);
 const edited = editPatcher(device.document, [
  { op:'add', id:'gain', maxclass:'newobj', text:'*~ 0.5', rect:[100, 60, 80, 22] },
  { op:'disconnect', source:'a', outlet:0, destination:'b', inlet:0 },
  { op:'connect', source:'a', outlet:0, destination:'gain', inlet:0 },
  { op:'connect', source:'gain', outlet:0, destination:'b', inlet:0 },
 ]);
 const output = decodeDevice(encodeDevice(device, edited)).document as unknown as typeof document;
 assert.deepEqual(output.patcher.other, { preserve:1 });
 assert.equal(output.patcher.boxes[0].box.extra, 'preserve');
 assert.equal(output.patcher.boxes.length, 3); assert.equal(output.patcher.lines.length, 2);
 assert.equal(decodeDevice(original).document.patcher.boxes.length, 2);
});

test('edits a Max patch when the host does not provide structuredClone', () => {
 const previous = globalThis.structuredClone;
 try {
  (globalThis as { structuredClone?: typeof structuredClone }).structuredClone = undefined;
  const original = decodeDevice(fixture()).document;
  const result = editPatcher(original, [{ op:'set_text', id:'a', text:'*~ 2' }]);
  assert.equal(result.patcher.boxes[0].box.text, '*~ 2');
  assert.equal(original.patcher.boxes[0].box.text, 'plugin~');
 } finally { globalThis.structuredClone = previous; }
});

test('rejects unsupported or damaged containers and invalid graph edits', () => {
 assert.throws(() => decodeDevice(Buffer.concat([fixture(), Buffer.from('extra')])), /unsupported|length/i);
 const doc = decodeDevice(fixture()).document;
 assert.throws(() => editPatcher(doc, [{ op:'connect', source:'missing', outlet:0, destination:'b', inlet:0 }]), /missing/i);
 assert.throws(() => editPatcher(doc, [{ op:'add', id:'a', maxclass:'newobj', text:'x', rect:[0,0,10,10] }]), /duplicate/i);
 assert.equal(doc.patcher.boxes.length, 2);
});

test('rejects expr~ as a top-level MSP object instead of producing a broken device', () => {
 const doc = decodeDevice(fixture()).document;
 assert.throws(() => editPatcher(doc, [{ op:'add', id:'shaper', maxclass:'newobj', text:'expr~ tanh($v1)', rect:[0,0,100,22] }]), /expr~/);
});

test('refuses to rewrite a device whose external dependencies require packaging', () => {
 const doc = decodeDevice(fixture()).document;
 doc.patcher.dependency_cache = [{ name: 'external.js' }];
 assert.throws(() => editPatcher(doc, []), /dependencies/i);
});

test('adds an automatable Live dial with a parameter name, initial value and presentation', () => {
 const doc = decodeDevice(fixture()).document;
 const updated = editPatcher(doc, [{ op:'add', id:'drive', maxclass:'live.dial', rect:[10,10,44,47], parameter_name:'Drive', parameter_min:0, parameter_max:1, parameter_initial:0.5, presentation_rect:[10,10,44,47] }]);
 const dial = updated.patcher.boxes.find((item) => item.box.id === 'drive')!.box;
 assert.equal(dial.parameter_enable, 1); assert.equal(dial.varname, 'Drive');
 assert.equal((dial.saved_attribute_attributes as any).valueof.parameter_initial[0], 0.5);
 assert.deepEqual((updated.patcher.parameters as any).drive, ['Drive', 'Drive', 0]);
});

test('creates uniquely named files without requiring an output path', async () => {
 const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibleton-max-default-'));
 try {
  const template = path.join(dir, 'template.amxd'); fs.writeFileSync(template, fixture());
  const input = { template_path: template, name:'Distortion' };
  const a = await maxDeviceFileTool('create_max_device', input, { defaultDirectory: dir }) as { created: string };
  const b = await maxDeviceFileTool('create_max_device', input, { defaultDirectory: dir }) as { created: string };
  assert.equal(path.basename(a.created), 'Distortion.amxd'); assert.equal(path.basename(b.created), 'Distortion 2.amxd');
  assert.notEqual(a.created, b.created); assert.equal(decodeDevice(fs.readFileSync(a.created)).document.patcher.boxes.length, 2);
 } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('accepts empty optional fields sent by strict tool providers', async () => {
 const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibleton-max-strict-'));
 try {
  const template = path.join(dir, 'template.amxd'); fs.writeFileSync(template, fixture());
  const result = await maxDeviceFileTool('create_max_device', { template_path: template, output_path: '', name: 'Effect', operations: [
    { op:'add', id:'shape', maxclass:'newobj', text:'tanh~', rect:[10,10,80,22], presentation_rect:[], parameter_name:'', parameter_min:0, parameter_max:0, parameter_initial:0 }
  ] }, { defaultDirectory:dir }) as { created:string };
  const object = decodeDevice(fs.readFileSync(result.created)).document.patcher.boxes.find(({ box }) => box.id === 'shape')!.box;
  assert.equal(object.text, 'tanh~'); assert.equal(object.presentation_rect, undefined);
  assert.equal(path.basename(result.created), 'Effect.amxd');
 } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('editing without output_path creates a uniquely named sibling copy', async () => {
 const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibleton-max-edit-'));
 try {
  const original=path.join(dir,'Original.amxd'); fs.writeFileSync(original,fixture());
  const input={source_path:original,output_path:'',operations:[{op:'set_text',id:'a',text:'*~ 2'}]};
  const a=await maxDeviceFileTool('edit_max_device_file',input) as {created:string};
  const b=await maxDeviceFileTool('edit_max_device_file',input) as {created:string};
  assert.equal(path.basename(a.created),'Original - Edited.amxd');
  assert.equal(path.basename(b.created),'Original - Edited 2.amxd');
  assert.equal(decodeDevice(fs.readFileSync(original)).document.patcher.boxes[0].box.text,'plugin~');
  assert.equal(decodeDevice(fs.readFileSync(a.created)).document.patcher.boxes[0].box.text,'*~ 2');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('tools create and edit a separate device file without overwriting', async () => {
 const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
 const { runTool } = await import('./dispatcher.js');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibleton-max-'));
 try {
  const template = path.join(dir, 'template.amxd'); const created = path.join(dir, 'created.amxd'); const edited = path.join(dir, 'edited.amxd');
  fs.writeFileSync(template, fixture());
  const context = { application: { song: { tracks: [], scenes: [], returnTracks: [] } } } as any;
  const templateInfo = await runTool(context, 'inspect_max_template', { kind: 'audio_effect', template_path: template }) as { objects: { id: string }[] };
  assert.equal(templateInfo.objects[0].id, 'a');
  const createResult = await runTool(context, 'create_max_device', { template_path: template, output_path: created }) as { validation: { structure:string; live_validation:string; audio_paths:{right:string} } };
  assert.equal(createResult.validation.structure, 'passed');
  assert.equal(createResult.validation.live_validation, 'not_performed');
  assert.equal(createResult.validation.audio_paths.right, 'missing');
  const validation = await runTool(context, 'validate_max_device_file', { source_path:created }) as { validation:{live_validation:string} };
  assert.equal(validation.validation.live_validation, 'not_performed');
  const inspected = await runTool(context, 'inspect_max_device_file', { source_path: created, offset: 1 }) as { objects: { id: string }[]; object_count: number };
  assert.equal(inspected.object_count, 2); assert.equal(inspected.objects[0].id, 'b');
  await runTool(context, 'edit_max_device_file', { source_path: created, output_path: edited, operations: [{ op:'set_text', id:'a', text:'cycle~ 440' }] });
  assert.equal(decodeDevice(fs.readFileSync(edited)).document.patcher.boxes[0].box.text, 'cycle~ 440');
  assert.equal(decodeDevice(fs.readFileSync(created)).document.patcher.boxes[0].box.text, 'plugin~');
  await assert.rejects(() => runTool(context, 'edit_max_device_file', { source_path: created, output_path: created, operations: [] }));
 } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('reports Max tool failures with their diagnostic detail in Chinese', async () => {
 const { runTool } = await import('./dispatcher.js');
 const { friendlyToolError } = await import('../errors.js');
 const { toolState } = await import('../state.js');
 const before = toolState.activeLanguage;
 const context = { application: { song: { tracks: [], scenes: [], returnTracks: [] } } } as any;
 try {
  toolState.activeLanguage = 'zh';
  await assert.rejects(() => runTool(context, 'inspect_max_template', { kind:'invalid' }), (error: unknown) => {
   const message = friendlyToolError(error, 'zh');
   assert.match(message, /Max/); assert.match(message, /audio_effect/); return true;
  });
 } finally { toolState.activeLanguage = before; }
});

test('long English diagnostics retain their detail in Chinese tool output', async () => {
 const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
 const {runTool}=await import('./dispatcher.js'); const {friendlyToolError}=await import('../errors.js'); const {toolState}=await import('../state.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibleton-max-error-')); const prior=toolState.activeLanguage;
 try {
  const source=path.join(dir,'source.amxd'); fs.writeFileSync(source,fixture()); toolState.activeLanguage='zh';
  const context={application:{song:{tracks:[],scenes:[],returnTracks:[]}}} as any;
  await assert.rejects(()=>runTool(context,'edit_max_device_file',{source_path:source,output_path:'invalid.amxd',operations:[]}), (e:unknown)=>{assert.match(friendlyToolError(e,'zh'),/output_path must be an absolute/);return true;});
 } finally {toolState.activeLanguage=prior;fs.rmSync(dir,{recursive:true,force:true});}
});

test('retains a long Max object diagnostic through language sanitization', async () => {
 const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
 const {runTool}=await import('./dispatcher.js'); const {friendlyToolError,sanitizeToolResultLanguage}=await import('../errors.js'); const {toolState}=await import('../state.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibleton-max-error-')); const prior=toolState.activeLanguage;
 try {
  const source=path.join(dir,'source.amxd'); fs.writeFileSync(source,fixture()); toolState.activeLanguage='zh';
  const context={application:{song:{tracks:[],scenes:[],returnTracks:[]}}} as any;
  await assert.rejects(()=>runTool(context,'edit_max_device_file',{source_path:source,operations:[{op:'add',id:'bad',maxclass:'newobj',text:'expr~ tanh($v1)',rect:[0,0,20,20]}]}), (e:unknown)=>{
   const result=sanitizeToolResultLanguage({error:friendlyToolError(e,'zh')},'zh') as {error:string};
   assert.match(result.error,/expr~ is not a supported/); return true;
  });
 } finally {toolState.activeLanguage=prior;fs.rmSync(dir,{recursive:true,force:true});}
});
