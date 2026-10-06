import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { testConnection } from "./testconn.js";
import { toolHooks } from "../state.js";

// A relay's model catalog can omit a model that chat accepts.
test("explicit Custom connection test verifies a model missing from the catalog", async () => {
  let probes = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "upstream-model" }] }));
    } else {
      probes++;
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const getManualConfig = toolHooks.getManualConfig;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    toolHooks.getManualConfig = () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "relay-alias" });
    const quick = await testConnection("custom", false);
    assert.equal(probes, 0, "opening settings must not spend generation tokens");
    assert.equal(quick.status, "connected");
    assert.match(quick.detail ?? "", /not in the list/);
    const full = await testConnection("custom", true);
    assert.equal(full.status, "connected");
    assert.equal(probes, 1, "an explicit test must prove generation works");
  } finally {
    toolHooks.getManualConfig = getManualConfig;
    server.close();
    await once(server, "close");
  }
});

for (const body of ["", "<html>UI page</html>", "null", "{}", '{"choices":']) {
  test(`Custom connection probe rejects invalid success body ${JSON.stringify(body)}`, async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      if (req.url === "/v1/models") {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200);
        res.end(body);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const getManualConfig = toolHooks.getManualConfig;
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      toolHooks.getManualConfig = () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
      const result = await testConnection("custom", true);
      assert.equal(result.status, "error");
      assert.match(result.detail ?? "", /response|JSON/i);
    } finally {
      toolHooks.getManualConfig = getManualConfig;
      server.close();
      await once(server, "close");
    }
  });
}
