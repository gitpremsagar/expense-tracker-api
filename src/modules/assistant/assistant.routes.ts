import { Router } from "express";
import * as assistantController from "./assistant.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";

const router = Router();

router.use(authenticate);

router.post("/parse", assistantController.parse);
router.post("/confirm", assistantController.confirm);
router.post("/apply", assistantController.apply);
router.post("/undo", assistantController.undo);

router.get("/preferences", assistantController.getPreferences);
router.put("/preferences", assistantController.updatePreferences);

router.get("/conversations", assistantController.listConversations);
router.get("/conversations/:conversationId", assistantController.getConversation);
router.delete("/conversations/:conversationId", assistantController.deleteConversation);

router.get("/usage", assistantController.getUsage);

export default router;
