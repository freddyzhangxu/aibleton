import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const production = process.argv.includes("--production");

// The M4A decoder can route to many codecs that AIbleton does not support.
// Since this build bundles CommonJS into one file, even its dynamic imports
// pull those codecs (and their WASM) into the .ablx. Keep AAC/ALAC, MP3, FLAC,
// and PCM support, and replace only the unused M4A codec branches with small
// runtime errors. MP3 and FLAC remain available through dsp.ts's direct imports.
const unsupportedMp4Codecs: Record<string, string> = {
  "@audio/decode-ac3": "AC-3",
  "@audio/decode-amr": "AMR",
  "@audio/decode-dts": "DTS",
  "@audio/decode-eac3": "E-AC-3",
  "@audio/decode-opus/core": "Opus",
};

const trimUnsupportedMp4Codecs: esbuild.Plugin = {
  name: "trim-unsupported-mp4-codecs",
  setup(build) {
    build.onResolve({ filter: /^@audio\/decode-(?:ac3|amr|dts|eac3|opus)(?:\/core)?$/ }, (args) => {
      if (!args.importer.includes("/node_modules/@audio/decode-mp4/")) return;
      return { path: args.path, namespace: "unsupported-mp4-codec" };
    });

    build.onLoad({ filter: /.*/, namespace: "unsupported-mp4-codec" }, (args) => {
      const codec = unsupportedMp4Codecs[args.path] ?? "unknown";
      const fail = `throw new Error(${JSON.stringify(`Unsupported MP4 audio codec: ${codec}`)})`;
      return {
        contents: `export async function decoder() { ${fail}; }\nexport async function createOpusDecoder() { ${fail}; }`,
        loader: "js",
      };
    });
  },
};

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
  plugins: [trimUnsupportedMp4Codecs],
  // Stamp each build so AIbletonBar can detect a reload and refresh its webview.
  // __APP_VERSION__ lets the served page show the real version (settings view).
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
