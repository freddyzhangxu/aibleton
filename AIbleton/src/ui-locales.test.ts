import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");

// Eval the I18N literal from the inline script. Nested locale objects are
// indented deeper than the closing "};" of the top-level literal.
const match = html.match(/const I18N = (\{[\s\S]*?\n    \});/);
assert.ok(match, "I18N literal not found in interface.html");
const I18N = runInNewContext("(" + match[1] + ")") as Record<string, Record<string, string>>;

test("every locale defines exactly the English key set", () => {
  const enKeys = Object.keys(I18N.en).sort();
  assert.ok(enKeys.length > 0);
  for (const lang of Object.keys(I18N)) {
    assert.deepEqual(Object.keys(I18N[lang]).sort(), enKeys, `${lang} locale keys differ from en`);
  }
});

test("localized strings keep the English {placeholders}", () => {
  const placeholders = (value: string) => (value.match(/\{[a-z]+\}/gi) ?? []).sort();
  for (const [lang, dict] of Object.entries(I18N)) {
    for (const [key, enValue] of Object.entries(I18N.en)) {
      assert.deepEqual(placeholders(dict[key] ?? ""), placeholders(enValue), `${lang}.${key} placeholders differ from en`);
    }
  }
});
