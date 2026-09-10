import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const pgEntry = path.resolve(root, "../../lib/db/node_modules/pg/esm/index.mjs");
const outdir = path.join(root, "test/.generated");
await build({
  entryPoints: {
    "test-support": path.join(root, "test/test-support.ts"),
    "route-test-support": path.join(root, "test/route-test-support.ts"),
    "cleanup-alerts": path.join(root, "src/lib/cleanup-alerts.ts"),
  },
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
