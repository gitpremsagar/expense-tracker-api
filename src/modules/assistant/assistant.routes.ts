import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import * as assistantController from "./assistant.controller.js";

const router = Router();

router.use(authenticate);

router.get("/status", assistantController.status);
router.post("/consent", assistantController.consent);
router.get("/preferences", assistantController.getPreferences);
router.put("/preferences", assistantController.updatePreferences);
router.get("/usage", assistantController.usage);
router.delete("/data", assistantController.eraseData);

router.post("/threads", assistantController.createConversation);
router.get("/threads", assistantController.listConversations);
router.get("/threads/:id", assistantController.getConversation);
router.delete("/threads/:id", assistantController.removeConversation);
router.post("/threads/:id/messages", assistantController.sendMessage);
router.post(
  "/threads/:id/attachments",
  assistantController.attachmentUpload,
  assistantController.sendAttachment,
);

router.post("/actions/confirm", assistantController.confirm);
router.post("/actions/:batchId/undo", assistantController.undo);

router.post("/imports", assistantController.statementUpload, assistantController.createImport);
router.get("/imports", assistantController.listStatementImports);
router.get("/imports/:id", assistantController.getStatementImport);
router.post("/imports/:id/commit", assistantController.commitStatementImport);
router.delete("/imports/:id", assistantController.discardStatementImport);

export default router;
