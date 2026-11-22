import { Router } from "express";
import * as budgetController from "./budget.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.get("/", budgetController.list);
router.put("/", budgetController.upsert);
router.delete("/:id", budgetController.remove);

export default router;
