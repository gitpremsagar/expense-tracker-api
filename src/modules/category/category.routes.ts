import { Router } from "express";
import * as categoryController from "./category.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/", categoryController.create);
router.get("/", categoryController.list);
router.put("/:id", categoryController.update);
router.delete("/:id", categoryController.remove);

export default router;
