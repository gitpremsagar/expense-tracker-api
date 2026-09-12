import { Router } from "express";
import * as reportController from "./report.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.get("/monthly", reportController.monthly);
router.get("/annual", reportController.annual);

export default router;
