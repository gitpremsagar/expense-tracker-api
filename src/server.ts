import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import authRoutes from "./modules/auth/auth.routes.js";
import categoryRoutes from "./modules/category/category.routes.js";
import categoryGroupRoutes from "./modules/categoryGroup/categoryGroup.routes.js";
import transactionRoutes from "./modules/transaction/transaction.routes.js";
import reportRoutes from "./modules/report/report.routes.js";
import debtRoutes from "./modules/debt/debt.routes.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { prisma } from "./lib/prisma.js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: [env.FRONTEND_URL, "https://moneytracker365.com", "https://www.moneytracker365.com"],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRoutes);
app.use("/categories", categoryRoutes);
app.use("/category-groups", categoryGroupRoutes);
app.use("/transactions", transactionRoutes);
app.use("/reports", reportRoutes);
app.use("/debts", debtRoutes);

app.use(errorHandler);

const PORT = env.PORT ?? 3710;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
