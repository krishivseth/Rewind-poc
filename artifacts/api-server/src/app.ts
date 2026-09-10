import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { settings } from "./lib/config";

const app: Express = express();

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => (req.url ?? "").includes("/events") || (req.url ?? "").endsWith("/healthz") },
  serializers: { req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; }, res(res) { return { statusCode: res.statusCode }; } },
}));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", router);

// Outside Replit's path router the API process also serves the built frontend, so one process is enough.
const dist = settings.frontendDist;
if (existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => { res.sendFile(path.join(dist, "index.html")); });
}

export default app;
