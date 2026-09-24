import { Router } from "express";
import { ValidationError } from "../ingestion/types";
import { searchPassages } from "../retrieval/retrievalService";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const result = await searchPassages({
      q: req.query.q,
      limit: req.query.limit,
      personId: req.query.personId,
      sourceId: req.query.sourceId,
      mode: req.query.mode,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as searchRouter };
