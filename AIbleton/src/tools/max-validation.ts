import type { PatcherDocument } from './max-device.js';

type Issue = { code:string; object?:string; detail:string };
export type MaxValidation = { structure:'passed'|'failed'; live_validation:'not_performed'; audio_paths:{left:'connected'|'missing'|'not_applicable';right:'connected'|'missing'|'not_applicable'}; error_count:number; warning_count:number; errors:Issue[]; warnings:Issue[]; limitations:string[] };
const KNOWN_OBJECTS = new Set(['plugin~','plugout~','*~','+~','-~','/~','tanh~','clip~','jit.world','jit.window','jit.gl.gridshape','peakamp~','scale','clip','loadmess','expr','>=','counter','*','+','-','!-','prepend']);

/** Static, top-level checks only. A path is a graph path, not proof of audio signal flow. */
export function validateMaxPatcher(document:PatcherDocument, options:{expectAudioIO?:boolean} = {}): MaxValidation {
 const errors:Issue[] = [], warnings:Issue[] = [];
 const boxes: PatcherDocument['patcher']['boxes'][number]['box'][]=[];
 for(const record of document.patcher.boxes) {
  if(!record || typeof record !== 'object' || !record.box || typeof record.box !== 'object' || Array.isArray(record.box)) errors.push({code:'invalid_object',detail:'Malformed object record.'});
  else boxes.push(record.box);
 }
 const byId=new Map<string,typeof boxes[number]>(); const parameterNames=new Set<string>(); const longNames=new Set<string>();
 for(const b of boxes) {
  if(typeof b.id!=='string'||!b.id.trim()||byId.has(b.id)) errors.push({code:'duplicate_or_empty_id',object:b.id,detail:'Object ID is empty or duplicated.'}); else byId.set(b.id,b);
  if(typeof b.maxclass!=='string'||!b.maxclass.trim()) errors.push({code:'invalid_class',object:b.id,detail:'Object class is missing.'});
  if(b.maxclass==='newobj') {
   const objectName=typeof b.text==='string'?b.text.trim().split(/\s+/)[0]:'';
   if(!objectName) errors.push({code:'empty_object',object:b.id,detail:'Object text is empty.'});
   else if(objectName==='expr~') errors.push({code:'unsupported_object',object:b.id,detail:'Top-level expr~ is unsupported; use standard MSP objects.'});
   else if(!KNOWN_OBJECTS.has(objectName)) warnings.push({code:'object_unverified',object:b.id,detail:`Object ${objectName} was not checked against a Max installation.`});
  }
  if(b.parameter_enable===1) {
   const attributes=b.saved_attribute_attributes as {valueof?:{parameter_mmin?:unknown;parameter_mmax?:unknown;parameter_initial?:unknown;parameter_longname?:unknown}}|undefined;
   const p=attributes?.valueof; const min=p?.parameter_mmin, max=p?.parameter_mmax, initial=p?.parameter_initial;
   if(typeof min==='number'&&typeof max==='number'&&(!Number.isFinite(min)||!Number.isFinite(max)||min>=max)) errors.push({code:'parameter_range',object:b.id,detail:'Parameter minimum must be less than its maximum.'});
   if(Array.isArray(initial)&&typeof initial[0]==='number'&&((typeof min==='number'&&initial[0]<min)||(typeof max==='number'&&initial[0]>max))) errors.push({code:'parameter_initial',object:b.id,detail:'Initial value is outside the parameter range.'});
   if(typeof b.varname!=='string'||!b.varname) warnings.push({code:'parameter_name',object:b.id,detail:'Enabled parameter has no scripting name.'});
   else if(parameterNames.has(b.varname)) errors.push({code:'duplicate_parameter_name',object:b.id,detail:`Parameter scripting name ${b.varname} is duplicated.`});
   else parameterNames.add(b.varname);
   const longName=p?.parameter_longname;
   if(typeof longName==='string'&&longName){if(longNames.has(longName)) errors.push({code:'duplicate_parameter_longname',object:b.id,detail:`Parameter long name ${longName} is duplicated.`}); else longNames.add(longName);}
  }
 }
 const lines=document.patcher.lines??[]; const valid:{source:[string,number];destination:[string,number]}[]=[];
 for(const record of lines) {
  const l=record?.patchline;
  const s=l?.source, d=l?.destination;
  if(!Array.isArray(s)||!Array.isArray(d)||s.length!==2||d.length!==2||typeof s[0]!=='string'||typeof d[0]!=='string'||!Number.isInteger(s[1])||s[1]<0||!Number.isInteger(d[1])||d[1]<0){errors.push({code:'invalid_connection',detail:'Connection endpoint or port is invalid.'});continue;}
  const src=byId.get(s[0]), dst=byId.get(d[0]);
  if(!src||!dst){errors.push({code:'missing_object',detail:`Connection references a missing object: ${!src?s[0]:d[0]}.`});continue;}
  let bad=false;
  if(typeof src.numoutlets==='number'&&s[1]>=src.numoutlets){errors.push({code:'invalid_outlet',object:s[0],detail:`Outlet ${s[1]} exceeds the declared outlet count ${src.numoutlets}.`});bad=true;}
  if(typeof dst.numinlets==='number'&&d[1]>=dst.numinlets){errors.push({code:'invalid_inlet',object:d[0],detail:`Inlet ${d[1]} exceeds the declared inlet count ${dst.numinlets}.`});bad=true;}
  if(!bad) valid.push({source:s,destination:d});
 }
 const input=boxes.find(b=>typeof b.text==='string'&&b.text.trim().split(/\s+/)[0]==='plugin~'), output=boxes.find(b=>typeof b.text==='string'&&b.text.trim().split(/\s+/)[0]==='plugout~');
 if(options.expectAudioIO&&(!input||!output)) warnings.push({code:'audio_io_missing',detail:'The audio effect is missing a top-level plugin~ or plugout~ object.'});
 const channel=(n:number):'connected'|'missing'|'not_applicable'=>{
  if(!input||!output) return options.expectAudioIO?'missing':'not_applicable';
  const pending=valid.filter(l=>l.source[0]===input.id&&l.source[1]===n).map(l=>l.destination);
  const seen=new Set<string>();
  while(pending.length){const [id,port]=pending.shift()!; if(id===output.id&&port===n)return 'connected'; if(id===output.id||seen.has(id))continue; seen.add(id); for(const l of valid)if(l.source[0]===id)pending.push(l.destination);}
  return 'missing';
 };
 const audio_paths={left:channel(0),right:channel(1)};
 for(const [side,state] of Object.entries(audio_paths))if(state==='missing')warnings.push({code:'audio_path_missing',detail:`No top-level graph path was found for the ${side} channel.`});
 for(const b of boxes){
  if(b.maxclass!=='newobj'||typeof b.text!=='string'||!/^\s*jit\.(?:world|window)(?:\s|$)/.test(b.text)) continue;
  const t=b.text; const attr=(name:string)=>{const m=t.match(new RegExp(`@${name}\\s+([01])(?:\\s|$)`));return m?Number(m[1]):undefined;};
  if((attr('visible')??1)===1&&(attr('enable')===1||/^\s*jit\.window\b/.test(t)))warnings.push({code:'window_auto_open',object:b.id,detail:'The visual window may open automatically.'});
  if(attr('floating')===1) warnings.push({code:'window_floating',object:b.id,detail:'The visual window requests floating mode.'});
  if(attr('fullscreen')===1) warnings.push({code:'window_fullscreen',object:b.id,detail:'The visual window requests fullscreen mode.'});
  const hasControl=valid.some(l=>{
   if(l.destination[0]!==b.id)return false;
   const text=byId.get(l.source[0])?.text;
   return typeof text==='string' && /(?:\bclose\b|\b(?:visible|enable|fullscreen)\s+(?:0|\$\d+)(?:\s|$)|\bprepend\s+(?:visible|enable|fullscreen)\b)/.test(text);
  });
  if(!hasControl)warnings.push({code:'window_no_visibility_control',object:b.id,detail:'No directly connected visibility or close control was found.'});
 }
 return {structure:errors.length?'failed':'passed',live_validation:'not_performed',audio_paths,error_count:errors.length,warning_count:warnings.length,errors:errors.slice(0,20),warnings:warnings.slice(0,20),limitations:['Static top-level inspection only. Ports are checked only when counts are declared; graph paths do not prove audio routing, sound, object availability, or Live/Max execution. Nested patches and runtime messages are not fully checked. Issue lists show at most 20 each.']};
}
