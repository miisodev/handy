import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Clean & compile TypeScript declarations + ESM library modules to lib/
rmSync(resolve(rootDir, "lib"), { recursive: true, force: true });
execFileSync(resolve(rootDir, "node_modules/.bin/tsc"), ["-p", resolve(rootDir, "tsconfig.json")], {
  cwd: rootDir,
  stdio: "inherit",
});

// 2. Bundle self-contained CLI + stdio MCP binary into bin/handy.js
mkdirSync(resolve(rootDir, "bin"), { recursive: true });
const outBin = resolve(rootDir, "bin/handy.js");

await build({
  entryPoints: [resolve(rootDir, "src/cli.ts")],
  outfile: outBin,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __handyCreateRequire } from "node:module";',
      "const require = __handyCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

chmodSync(outBin, 0o755);

// 3. Generate crisp 512x512 public/handy.png icon for MCPB manifest.json
mkdirSync(resolve(rootDir, "public"), { recursive: true });
const { encodePng } = await import(resolve(rootDir, "lib/png.js"));
const { drawCircleRing, drawLine, fillRect, strokeRect } = await import(resolve(rootDir, "lib/font.js"));

const size = 512;
const rgba = new Uint8Array(size * size * 4);
fillRect(rgba, size, size, 0, 0, size, size, [15, 23, 42, 255]);
for (const pos of [128, 256, 384]) {
  const alpha = pos === 256 ? 115 : 70;
  drawLine(rgba, size, size, pos, 64, pos, 448, [14, 165, 233, alpha]);
  drawLine(rgba, size, size, 64, pos, 448, pos, [14, 165, 233, alpha]);
}
strokeRect(rgba, size, size, 56, 56, 400, 400, [56, 189, 248, 255], 8);
drawCircleRing(rgba, size, size, 296, 232, 60, 12, [255, 255, 255, 230]);
drawCircleRing(rgba, size, size, 296, 232, 60, 8, [239, 68, 68, 255]);
drawCircleRing(rgba, size, size, 296, 232, 14, 10, [239, 68, 68, 255]);
fillRect(rgba, size, size, 210, 230, 56, 4, [239, 68, 68, 255]);
fillRect(rgba, size, size, 326, 230, 56, 4, [239, 68, 68, 255]);
fillRect(rgba, size, size, 294, 146, 4, 56, [239, 68, 68, 255]);
fillRect(rgba, size, size, 294, 262, 4, 56, [239, 68, 68, 255]);

const iconPng = encodePng(size, size, rgba);
writeFileSync(resolve(rootDir, "public/handy.png"), iconPng);

console.log("Built lib/, bin/handy.js, and public/handy.png successfully.");
