import { Router, type IRouter } from "express";

const router: IRouter = Router();
router.get("/healthz", (_req, res) => { res.json({ status: "ok" }); });
router.get("/health", (_req, res) => { res.json({ ok: true }); });
export default router;
