import express, { Router, type ErrorRequestHandler } from "express";
import { answerQuestion } from "../answering/answerService";
import { InvalidModelResponseError } from "../answering/types";
import { ValidationError } from "../ingestion/types";
import { LanguageModelConfigError, LanguageModelError } from "../llm/errors";

const router = Router();

router.use(express.json({ limit: "16kb" }));

router.post("/", async (req, res) => {
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.status(400).json({ error: "request body must be a JSON object" });
    return;
  }
  try {
    const { question, personId, sourceId, limit } = body as Record<string, unknown>;
    res.json(await answerQuestion({ question, personId, sourceId, limit }));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof InvalidModelResponseError || err instanceof LanguageModelError) {
      res.status(502).json({ error: err.message });
    } else if (err instanceof LanguageModelConfigError) {
      res.status(503).json({ error: err.message });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

/** Malformed or oversized JSON bodies, rejected by express.json(), get a JSON error. */
const bodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 413) {
    res.status(status).json({ error: status === 413 ? "request body is too large" : "request body must be valid JSON" });
    return;
  }
  next(err);
};
router.use(bodyErrorHandler);

export { router as answerRouter };
