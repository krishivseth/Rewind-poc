import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(root, "test/test-support.ts")],
  outfile: path.join(root, "test/.generated/test-support.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["@google-cloud/storage"],
});