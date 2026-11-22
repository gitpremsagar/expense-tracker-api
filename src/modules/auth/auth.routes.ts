import { Router } from "express";
import * as authController from "./auth.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { rateLimit } from "../../middlewares/rateLimit.js";

const router = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: "login" });
const signupLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, keyPrefix: "signup" });
const forgotLimiter = rateLimit({ windowMs: 15 * 60_000, max: 5, keyPrefix: "forgot" });
const resetLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: "reset" });

router.post("/signup", signupLimiter, authController.signup);
router.post("/login", loginLimiter, authController.login);
router.post("/refresh", authController.refresh);
router.post("/logout", authController.logout);
router.post("/forgot-password", forgotLimiter, authController.forgotPassword);
router.post("/reset-password", resetLimiter, authController.resetPassword);
router.get("/me", authenticate, authController.me);
router.put("/me", authenticate, authController.updateMe);
router.post("/change-password", authenticate, authController.changePassword);
router.post("/logout-all", authenticate, authController.logoutAll);
router.delete("/me", authenticate, authController.deleteMe);

export default router;
