import { Router } from "express";
import * as debtController from "./debt.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/", debtController.create);
router.get("/", debtController.list);
router.get("/:id", debtController.getOne);
router.put("/:id", debtController.update);
router.delete("/:id", debtController.remove);
router.post("/:id/payments", debtController.addPayment);
router.put("/:id/payments/:paymentId", debtController.updatePayment);
router.delete("/:id/payments/:paymentId", debtController.removePayment);

export default router;
