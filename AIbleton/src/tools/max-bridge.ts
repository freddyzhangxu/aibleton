import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// Runs inside a js object in the target Max patcher. Each bridge gets its own private mailbox.
const MAX_SCRIPT = String.raw`
autowatch = 0;
inlets = 1;
outlets = 0;
var dir = jsarguments[1];
var patch = this.patcher;
var self = this.box;
var last = "";
function readjson(name) {
  var f = new File(dir + "/" + name, "read");
  if (!f.isopen) return null;
  var text = f.readstring(f.eof); f.close();
  try { return JSON.parse(text); } catch (e) { return null; }
}
function writejson(name, value) {
  var f = new File(dir + "/" + name, "write");
  if (!f.isopen) throw new Error("Cannot write bridge file");
  f.eof = 0; f.writestring(JSON.stringify(value)); f.close();
}
function named(name) {
  if (typeof name !== "string" || !name) throw new Error("A scripting name is required");
  var obj = patch.getnamed(name);
  if (!obj || obj === self) throw new Error("Object not found or is the bridge: " + name);
  return obj;
}
function port(n) { if (typeof n !== "number" || n < 0 || n !== Math.floor(n)) throw new Error("Invalid port"); return n; }
function command(c) {
  if (c.op === "inspect") {
    var objects = [], item = patch.firstobject;
    while (item) { objects.push({ name: item.varname || "", maxclass: item.maxclass, rect: item.rect }); item = item.nextobject; }
    return { objects: objects, note: "Only objects with scripting names can be targeted. Connections are not enumerated." };
  }
  if (c.op === "add") {
    if (!c.id || patch.getnamed(c.id)) throw new Error("Empty or duplicate scripting name");
    if (!c.object || typeof c.object !== "string" || !Array.isArray(c.args) || typeof c.x !== "number" || typeof c.y !== "number") throw new Error("add requires id, object, args, x and y");
    var args = [c.x, c.y, c.object].concat(c.args);
    var obj = patch.newdefault.apply(patch, args); if (!obj) throw new Error("Object creation failed"); obj.varname = c.id;
    return { created: c.id };
  }
  if (c.op === "remove") { patch.remove(named(c.id)); return { removed: c.id }; }
  if (c.op === "connect" || c.op === "disconnect") {
    var a = named(c.source), b = named(c.destination), outlet = port(c.outlet), inlet = port(c.inlet);
    if (c.op === "connect") patch.connect(a, outlet, b, inlet); else patch.disconnect(a, outlet, b, inlet);
    return { operation: c.op, source: c.source, destination: c.destination };
  }
  if (c.op === "move") {
    if (!Array.isArray(c.rect) || c.rect.length !== 4) throw new Error("move requires rect [left, top, right, bottom]");
    named(c.id).rect = c.rect; return { moved: c.id };
  }
  throw new Error("Unsupported bridge operation: " + c.op);
}
function poll() {
  try {
    writejson("ready.json", {ready:true});
    var request = readjson("request.json");
    if (!request || !request.id || request.id === last) return;
    last = request.id;
    try { writejson("response.json", { id: request.id, result: command(request.command) }); }
    catch (e) { writejson("response.json", { id: request.id, error: String(e) }); }
  } catch (e) { post("AIbleton bridge: " + e + "\n"); }
}
if (dir) { writejson("ready.json", {ready:true}); var timer = new Task(poll, this); timer.interval = 300; timer.repeat(); }
`;

export async function prepareBridge(): Promise<{ directory: string; script: string; installation: string }> {
  const root = path.join(os.homedir(), 'Documents', 'AIbleton', 'MaxBridges');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'aibleton-max-'));
  await fs.chmod(directory, 0o700);
  const script = path.join(directory, 'AIbletonBridge.js');
  await fs.writeFile(script, MAX_SCRIPT, { flag: 'wx', mode: 0o600 });
  return { directory, script, installation: `In the target device's Max editor, add this object: js "${script}" "${directory}". Save the device; keep the bridge object in the target patcher.` };
}

export async function sendBridgeCommand(directory: string, command: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  const root = path.resolve(os.homedir(), 'Documents', 'AIbleton', 'MaxBridges');
  if (!path.isAbsolute(directory) || path.dirname(path.resolve(directory)) !== root || !path.basename(directory).startsWith('aibleton-max-')) throw new Error('Invalid bridge directory');
  if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Invalid bridge directory');
  try { const ready = await fs.stat(path.join(directory, 'ready.json')); if (Date.now() - ready.mtimeMs > 3000) throw new Error('stale'); } catch { throw new Error('Bridge not connected: install the bridge object in the target patcher first'); }
  const lockPath = path.join(directory, 'lock');
  const lock = await fs.open(lockPath, 'wx');
  const id = randomUUID();
  const request = path.join(directory, 'request.json'); const response = path.join(directory, 'response.json');
  try {
    await fs.rm(response, { force: true });
    const temporary = path.join(directory, `${id}.tmp`);
    await fs.writeFile(temporary, JSON.stringify({ id, command }), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, request);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const result = JSON.parse(await fs.readFile(response, 'utf8')) as { id: string; error?: string; result?: unknown };
        if (result.id === id) { if (result.error) throw new Error(`Max bridge error: ${result.error}`); return result.result; }
      } catch (e) { if (e instanceof Error && e.message.startsWith('Max bridge error:')) throw e; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Max bridge timed out; the operation may still have executed. Inspect the patch before retrying.');
  } finally { await fs.rm(request, { force: true }); await lock.close(); await fs.rm(lockPath, { force: true }); }
}
