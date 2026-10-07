import { Router } from "express";
import * as categoryGroupController from "./categoryGroup.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/", categoryGroupController.create);
router.get("/", categoryGroupController.list);
router.put("/:id", categoryGroupController.update);
router.delete("/:id", categoryGroupController.remove);

export default router;
