import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chatCustom } from "./custom.js";
import { toolHooks } from "../../state.js";

// Catch parsing failures that hide the HTTP status or accept invalid success bodies.
for (const fixture of [
  { status: 404, body: "", expected: /404/, absent: /Unexpected end/ },
  { status: 502, body: "<html>Bad Gateway</html>", expected: /temporarily overloaded/, absent: /Unexpected token/ },
  { status: 401, body: "", expected: /API key is invalid or expired/, absent: /Unexpected end/ },
  { status: 200, body: "", expected: /empty response body/i, absent: /Unexpected end/ },
  { status: 200, body: '{"choices":', expected: /invalid JSON/i, absent: /Unexpected end/ },
  { status: 200, body: "null", expected: /incomplete.*response/i, absent: /Cannot read/ },
  { status: 200, body: "{}", expected: /incomplete.*response/i, absent: /not initialized/ },
]) {
  test(`Custom reports HTTP ${fixture.status} with body ${JSON.stringify(fixture.body)}`, async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.writeHead(fixture.status, { "content-type": "application/json" });
      res.end(fixture.body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const debugLog = toolHooks.debugLog;
    toolHooks.debugLog = () => {};
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(chatCustom({} as never, {
        provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        authToken: "", model: "test-model", fromLocal: false,
      }, { language: "en" }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, fixture.expected);
        assert.doesNotMatch(error.message, fixture.absent);
        return true;
      });
    } finally {
      toolHooks.debugLog = debugLog;
      server.close();
      await once(server, "close");
    }
  });
}
