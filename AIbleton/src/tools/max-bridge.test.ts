import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { prepareBridge, sendBridgeCommand } from './max-bridge.js';

test('routes a command to one prepared bridge and returns its matching response', async () => {
 const prepared = await prepareBridge();
 try {
  await fs.writeFile(`${prepared.directory}/ready.json`, JSON.stringify({ ready: true }));
  const timer = setInterval(async () => {
    try { const req = JSON.parse(await fs.readFile(`${prepared.directory}/request.json`, 'utf8')); await fs.writeFile(`${prepared.directory}/response.json`, JSON.stringify({ id: req.id, result: { objects: ['gain'] } })); } catch { /* command not written yet */ }
  }, 10);
  try { assert.deepEqual(await sendBridgeCommand(prepared.directory, { op: 'inspect' }, 1000), { objects: ['gain'] }); } finally { clearInterval(timer); }
 } finally { await fs.rm(prepared.directory, { recursive: true, force: true }); }
});

test('requires the bridge to be installed before attempting an edit', async () => {
 const prepared = await prepareBridge();
 try { await assert.rejects(() => sendBridgeCommand(prepared.directory, { op: 'remove', id: 'x' }, 100), /not connected/i); }
 finally { await fs.rm(prepared.directory, { recursive:true, force:true }); }
});

test('the Max-side script responds to inspect and mutates the intended patcher', async () => {
 const vm = await import('node:vm'); const fsSync = await import('node:fs');
 const prepared = await prepareBridge();
 try {
  let tick: () => void = () => { throw new Error('timer not installed'); };
  const objects: any[] = [{ varname:'source', maxclass:'cycle~', rect:[0,0,80,20], nextobject:null }];
  const patch = {
   get firstobject() { return objects[0] ?? null; },
   getnamed(name: string) { return objects.find((o) => o.varname === name) ?? null; },
   newdefault(x: number, y: number, kind: string, ...args: string[]) { const obj = { varname:'', maxclass:kind, rect:[x,y,x+80,y+20], args, nextobject:null }; objects.push(obj); objects[0].nextobject = obj as any; return obj; },
   remove(obj: any) { objects.splice(objects.indexOf(obj), 1); }, connect() {}, disconnect() {},
  };
  class FakeFile {
   isopen = false; eof = 0; private data = ''; private mode: string; private name: string;
   constructor(name: string, mode: string) { this.name = name; this.mode = mode; try { if (mode === 'read') this.data = fsSync.readFileSync(name, 'utf8'); this.eof = this.data.length; this.isopen = true; } catch {} }
   readstring() { return this.data; } writestring(s: string) { this.data = s; }
   close() { if (this.mode === 'write') fsSync.writeFileSync(this.name, this.data); }
  }
  class FakeTask { interval = 0; constructor(fn: () => void) { tick = fn; } repeat() {} }
  const source = await fs.readFile(prepared.script, 'utf8');
  vm.runInNewContext(source, { jsarguments:['bridge', prepared.directory], patcher:patch, box:{}, File:FakeFile, Task:FakeTask, post() {}, JSON, Array, Error, Math, String });
  const pending = sendBridgeCommand(prepared.directory, { op:'add', id:'gain', object:'*~', args:['0.5'], x:20, y:30 }, 1000);
  await new Promise((resolve) => setTimeout(resolve, 30)); tick();
  assert.deepEqual(await pending, { created:'gain' }); assert.equal(objects[1].maxclass, '*~');
 } finally { await fs.rm(prepared.directory, { recursive:true, force:true }); }
});
