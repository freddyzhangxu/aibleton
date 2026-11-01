import assert from "node:assert/strict";
import test from "node:test";
import { logProviderUsage } from "./usage.js";
import { toolHooks } from "../../state.js";

test("reports OpenAI cache hits and reasoning tokens including real zero counts", () => {
 const original=toolHooks.debugLog;const lines:string[]=[];
 toolHooks.debugLog=(_ctx,line)=>lines.push(line);
 try {
  logProviderUsage({} as never,"openai",0,{input_tokens:2000,output_tokens:150,input_tokens_details:{cached_tokens:1024},output_tokens_details:{reasoning_tokens:120}});
  assert.match(lines[0],/cachedInput=1024/);
  assert.match(lines[0],/reasoning=120/);
  logProviderUsage({} as never,"openai",1,{input_tokens:2000,output_tokens:20,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}});
  assert.match(lines[1],/cachedInput=0/);
  assert.match(lines[1],/reasoning=0/);
 }finally{toolHooks.debugLog=original;}
});
