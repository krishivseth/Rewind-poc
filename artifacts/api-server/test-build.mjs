import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const pgEntry = path.resolve(root, "../../lib/db/node_modules/pg/esm/index.mjs");
const outdir = path.join(root, "test/.generated");
await build({
  entryPoints: [
    path.join(root, "test/test-support.ts"),
    path.join(root, "test/route-test-support.ts"),
  ],
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["@google-cloud/storage", "pg-native", "pino", "express", "@clerk/express"],
  plugins: [{
    name: "external-pg",
    setup(build) {
      build.onResolve({ filter: /^pg$/ }, () => ({
        path: `./${path.relative(outdir, pgEntry)}`,
        external: true,
      }));
    },
  }],
});
