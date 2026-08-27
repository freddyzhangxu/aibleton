import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  // Stamp each build so AIbletonBar can detect a reload and refresh its webview.
  // __APP_VERSION__ lets the served page show the real version (settings view).
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
