import type { Request, Response, NextFunction } from "express";
import { BadRequestError } from "../../utils/errors.js";
import * as assistantService from "./assistant.service.js";
import { parseMessageSchema } from "./assistant.validation.js";

export async function parse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = parseMessageSchema.parse(req.body);
    const result = await assistantService.parseMessage(req.user!.id, input);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function confirm(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await assistantService.confirmProposals(req.user!.id, req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function apply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await assistantService.applyActions(req.user!.id, req.body);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function undo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await assistantService.undoTransactions(req.user!.id, req.body);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getPreferences(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await assistantService.readPreferences(req.user!.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function updatePreferences(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await assistantService.writePreferences(req.user!.id, req.body);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function listConversations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await assistantService.readConversations(req.user!.id, req.query);
    res.status(200).json({ conversations: result });
  } catch (error) {
    next(error);
  }
}

function readConversationId(req: Request): string | undefined {
  const raw = req.params.conversationId;
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function getConversation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const conversationId = readConversationId(req);
    if (!conversationId) {
      throw new BadRequestError("Conversation id is required.");
    }
    const result = await assistantService.readConversation(req.user!.id, conversationId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function deleteConversation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const conversationId = readConversationId(req);
    if (!conversationId) {
      throw new BadRequestError("Conversation id is required.");
    }
    await assistantService.removeConversation(req.user!.id, conversationId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function getUsage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await assistantService.readUsage(req.user!.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
