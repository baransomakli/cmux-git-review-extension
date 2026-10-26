// Bundles the web client into dist/web next to the compiled server.
import { build } from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist/web", { recursive: true });
await build({
  entryPoints: ["web/app.ts"],
  bundle: true,
  format: "esm",
  target: "safari16",
  minify: true,
  outfile: "dist/web/app.js",
  logLevel: "warning",
});
for (const f of ["index.html", "style.css"]) fs.copyFileSync(`web/${f}`, `dist/web/${f}`);
