import { Router } from "express";
import * as transactionController from "./transaction.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/", transactionController.create);
router.get("/", transactionController.list);
router.get("/:id", transactionController.getOne);
router.put("/:id", transactionController.update);
router.delete("/:id", transactionController.remove);

export default router;
