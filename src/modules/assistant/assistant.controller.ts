import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/errors.js";
import {
  confirmSchema,
  createThreadSchema,
  importCommitSchema,
  importListQuerySchema,
  parseMessageSchema,
  preferencesSchema,
  threadListQuerySchema,
} from "./assistant.schema.js";
import {
  assertAssistantReady,
  getAssistantStatus,
  getPreferencesForClient,
  getThreadDetail,
  parseImageTurn,
  parseTextTurn,
  transcribeVoice,
} from "./assistant.service.js";
import {
  commitImport,
  discardImport,
  getImport,
  listImports,
  startImport,
} from "./assistant.imports.js";
import { confirmActions, undoBatch } from "./assistant.actions.js";
import { assertConsent, getPreference, recordConsent, updatePreference } from "./assistant.preferences.js";
import {
  clearAssistantData,
  createThread,
  deleteThread,
  listThreads,
} from "./assistant.threads.js";
import { assertQuota, getUsageSummary } from "./assistant.usage.js";
import { resolveTimezone } from "./assistant.time.js";

const memory = multer.memoryStorage();

function boundedUpload(maxMb: number) {
  const upload = multer({
    storage: memory,
    limits: { fileSize: Math.ceil(maxMb * 1024 * 1024), files: 1 },
  });

  return function middleware(req: Request, res: Response, next: NextFunction): void {
    upload.single("file")(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          next(new AppError(413, `That file is too large. The limit is ${maxMb} MB.`));
          return;
        }
        next(new AppError(400, "That upload could not be read. Please try again."));
        return;
      }

      next(error);
    });
  };
}

const attachmentUpload = boundedUpload(Math.max(env.ASSISTANT_MAX_IMAGE_MB, env.ASSISTANT_MAX_AUDIO_MB));
const statementUpload = boundedUpload(env.ASSISTANT_MAX_STATEMENT_MB);

function userId(req: Request): string {
  return req.user!.id;
}

async function timeZoneFor(req: Request, supplied?: string): Promise<string> {
  const preference = await getPreference(userId(req));
  return resolveTimezone(supplied ?? preference.timezone);
}

export async function status(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getAssistantStatus(userId(req)));
  } catch (error) {
    next(error);
  }
}

export async function consent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const preference = await recordConsent(userId(req));
    res.json({ consentAt: preference.consentAt });
  } catch (error) {
    next(error);
  }
}

export async function getPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getPreferencesForClient(userId(req)));
  } catch (error) {
    next(error);
  }
}

export async function updatePreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = preferencesSchema.parse(req.body);
    const preference = await updatePreference(userId(req), input);
    res.json({
      autoSaveCreates: preference.autoSaveCreates,
      thinkingMode: preference.thinkingMode,
      reasoningEffort: preference.reasoningEffort,
      timezone: preference.timezone,
      consentAt: preference.consentAt,
    });
  } catch (error) {
    next(error);
  }
}

export async function createConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createThreadSchema.parse(req.body ?? {});
    const thread = await createThread(userId(req), input.title);
    res.status(201).json({ thread });
  } catch (error) {
    next(error);
  }
}

export async function listConversations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = threadListQuerySchema.parse(req.query);
    res.json({ threads: await listThreads(userId(req), query.limit) });
  } catch (error) {
    next(error);
  }
}

export async function getConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getThreadDetail(userId(req), String(req.params["id"])));
  } catch (error) {
    next(error);
  }
}

export async function removeConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await deleteThread(userId(req), String(req.params["id"]));
    res.json({ message: "Conversation deleted" });
  } catch (error) {
    next(error);
  }
}

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    assertAssistantReady();
    const input = parseMessageSchema.parse(req.body);
    const result = await parseTextTurn({
      userId: userId(req),
      threadId: String(req.params["id"]),
      text: input.text,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function sendAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    assertAssistantReady();
    const file = req.file;

    if (!file) {
      throw new AppError(400, "Attach an image or voice note first.");
    }

    const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
    const threadId = String(req.params["id"]);

    if (kind === "IMAGE") {
      if (file.size > env.ASSISTANT_MAX_IMAGE_MB * 1024 * 1024) {
        throw new AppError(413, `That image is too large. The limit is ${env.ASSISTANT_MAX_IMAGE_MB} MB.`);
      }

      const result = await parseImageTurn({
        userId: userId(req),
        threadId,
        buffer: file.buffer,
        filename: file.originalname,
        timezone: typeof req.body?.timezone === "string" ? req.body.timezone : undefined,
      });
      res.json(result);
      return;
    }

    if (kind === "AUDIO") {
      if (file.size > env.ASSISTANT_MAX_AUDIO_MB * 1024 * 1024) {
        throw new AppError(413, `That recording is too large. The limit is ${env.ASSISTANT_MAX_AUDIO_MB} MB.`);
      }

      const result = await transcribeVoice({
        userId: userId(req),
        buffer: file.buffer,
        filename: file.originalname,
      });
      res.json(result);
      return;
    }

    throw new AppError(400, "Choose whether you are uploading a bill image or a voice note.");
  } catch (error) {
    next(error);
  }
}

export async function confirm(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    assertAssistantReady();
    const input = confirmSchema.parse(req.body);
    const timeZone = await timeZoneFor(req, input.timezone);
    const result = await confirmActions(
      userId(req),
      {
        clientRequestId: input.clientRequestId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        items: input.items,
      },
      timeZone,
    );

    if (input.messageId) {
      const message = await prisma.assistantMessage.findFirst({
        where: { id: input.messageId, userId: userId(req) },
      });

      if (message?.turn) {
        const turn = message.turn as Record<string, unknown>;
        const savedProposalIds = input.items.flatMap((item) =>
          item.kind === "CREATE" && item.proposalId ? [item.proposalId] : [],
        );
        const savedOperationIds = input.items.flatMap((item) =>
          item.kind !== "CREATE" && item.operationId ? [item.operationId] : [],
        );

        await prisma.assistantMessage.update({
          where: { id: message.id },
          data: {
            turn: {
              ...turn,
              savedProposalIds: [
                ...((turn.savedProposalIds as string[] | undefined) ?? []),
                ...savedProposalIds,
              ],
              savedOperationIds: [
                ...((turn.savedOperationIds as string[] | undefined) ?? []),
                ...savedOperationIds,
              ],
              savedBatchId: result.batchId,
            },
          },
        });
      }
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function undo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await undoBatch(userId(req), String(req.params["batchId"])));
  } catch (error) {
    next(error);
  }
}

export async function createImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    assertAssistantReady();
    await assertConsent(userId(req));
    await assertQuota(userId(req), "import");

    if (!req.file) {
      throw new AppError(400, "Choose a statement file first.");
    }

    const timeZone = await timeZoneFor(
      req,
      typeof req.body?.timezone === "string" ? req.body.timezone : undefined,
    );
    const threadId = typeof req.body?.threadId === "string" ? req.body.threadId : undefined;

    const result = await startImport({
      userId: userId(req),
      ...(threadId ? { threadId } : {}),
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      timeZone,
    });

    res.status(202).json({ import: result });
  } catch (error) {
    next(error);
  }
}

export async function listStatementImports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ imports: await listImports(userId(req)) });
  } catch (error) {
    next(error);
  }
}

export async function getStatementImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = importListQuerySchema.parse(req.query);
    res.json(await getImport(userId(req), String(req.params["id"]), query));
  } catch (error) {
    next(error);
  }
}

export async function commitStatementImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    assertAssistantReady();
    const input = importCommitSchema.parse(req.body);
    const timeZone = await timeZoneFor(req, input.timezone);
    const result = await commitImport(userId(req), String(req.params["id"]), input, timeZone);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function discardStatementImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await discardImport(userId(req), String(req.params["id"]));
    res.json({ message: "Import discarded" });
  } catch (error) {
    next(error);
  }
}

export async function usage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getUsageSummary(userId(req)));
  } catch (error) {
    next(error);
  }
}

export async function eraseData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await clearAssistantData(userId(req));
    res.json({ message: "Assistant data deleted" });
  } catch (error) {
    next(error);
  }
}

export { attachmentUpload, statementUpload };
