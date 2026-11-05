import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMaxPatcher } from './max-validation.js';

function patch(boxes: any[], lines: any[] = []) { return { patcher: { boxes: boxes.map(box=>({box})), lines: lines.map(patchline=>({patchline})) } }; }
const io = [{ id:'in', maxclass:'newobj', text:'plugin~', numoutlets:2 }, { id:'out', maxclass:'newobj', text:'plugout~', numinlets:2 }];
const wire=(source:string,outlet:number,destination:string,inlet:number)=>({source:[source,outlet],destination:[destination,inlet]});

test('reports missing objects and known out-of-range ports as errors', () => {
 const result = validateMaxPatcher(patch(io,[wire('in',2,'out',0),wire('missing',0,'out',0)]));
 assert.ok(result.errors.some(i=>i.code==='invalid_outlet'));
 assert.ok(result.errors.some(i=>i.code==='missing_object'));
 assert.equal(result.structure,'failed'); assert.equal(result.live_validation,'not_performed');
});

test('reports malformed object and connection records rather than crashing', () => {
 const result=validateMaxPatcher({patcher:{boxes:[null,{box:null}],lines:[null]}} as any);
 assert.ok(result.errors.some(i=>i.code==='invalid_object'));
 assert.ok(result.errors.some(i=>i.code==='invalid_connection'));
});

test('distinguishes a connected stereo graph from a missing right channel', () => {
 const good = validateMaxPatcher(patch(io,[wire('in',0,'out',0),wire('in',1,'out',1)]));
 assert.equal(good.audio_paths.left,'connected'); assert.equal(good.audio_paths.right,'connected');
 const partial = validateMaxPatcher(patch(io,[wire('in',0,'out',0)]));
 assert.equal(partial.audio_paths.right,'missing');
 assert.ok(partial.warnings.some(i=>i.code==='audio_path_missing'));
});

test('reports risky visual window defaults and preserves runtime uncertainty', () => {
 const r=validateMaxPatcher(patch([{id:'world',maxclass:'newobj',text:'jit.world demo @enable 1 @floating 1 @fullscreen 1'}]));
 assert.ok(r.warnings.some(i=>i.code==='window_auto_open'));
 assert.ok(r.warnings.some(i=>i.code==='window_floating'));
 assert.ok(r.warnings.some(i=>i.code==='window_fullscreen'));
 assert.ok(r.warnings.some(i=>i.code==='window_no_visibility_control'));
 assert.equal(r.live_validation,'not_performed');
});

test('does not mistake an always-open message for a close control', () => {
 const r=validateMaxPatcher(patch([{id:'world',maxclass:'newobj',text:'jit.world demo @enable 1'}, {id:'open',maxclass:'message',text:'visible 1'}],[wire('open',0,'world',0)]));
 assert.ok(r.warnings.some(i=>i.code==='window_no_visibility_control'));
});

test('an audio effect missing its output is not marked as not applicable', () => {
 const r=validateMaxPatcher(patch([io[0]]), {expectAudioIO:true});
 assert.equal(r.audio_paths.left,'missing'); assert.ok(r.warnings.some(i=>i.code==='audio_io_missing'));
});

test('checks declared parameters without treating unknown objects as verified', () => {
 const d=patch([{id:'d',maxclass:'live.dial',parameter_enable:1,varname:'Gain',saved_attribute_attributes:{valueof:{parameter_mmin:2,parameter_mmax:1,parameter_initial:[4]}}},{id:'u',maxclass:'newobj',text:'mystery~'}]);
 const r=validateMaxPatcher(d); assert.ok(r.errors.some(i=>i.code==='parameter_range')); assert.ok(r.warnings.some(i=>i.code==='object_unverified'));
});

test('detects duplicate enabled parameter names', () => {
 const r=validateMaxPatcher(patch([{id:'a',maxclass:'live.dial',parameter_enable:1,varname:'Gain'},{id:'b',maxclass:'live.dial',parameter_enable:1,varname:'Gain'}]));
 assert.ok(r.errors.some(i=>i.code==='duplicate_parameter_name'));
});

test('detects duplicate Live long names even when scripting names differ', () => {
 const r=validateMaxPatcher(patch([{id:'a',maxclass:'live.dial',parameter_enable:1,varname:'a',saved_attribute_attributes:{valueof:{parameter_longname:'Drive'}}},{id:'b',maxclass:'live.dial',parameter_enable:1,varname:'b',saved_attribute_attributes:{valueof:{parameter_longname:'Drive'}}}]));
 assert.ok(r.errors.some(i=>i.code==='duplicate_parameter_longname'));
});

test('limits long reports while retaining the total warning count', () => {
 const r=validateMaxPatcher(patch(Array.from({length:50},(_,i)=>({id:`x${i}`,maxclass:'newobj',text:`unknown${i}`}))));
 assert.equal(r.warning_count,50); assert.ok(r.warnings.length<=20);
});
