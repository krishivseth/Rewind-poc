import { Router, type IRouter } from "express";
import healthRouter from "./health";
import rewindRouter from "./rewind";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth);
router.use(rewindRouter);

export default router;
