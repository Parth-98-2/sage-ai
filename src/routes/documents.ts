import { Router } from "express";
import { getDocumentWithPassages } from "../ingestion/repository";
import { isUuid } from "../utils/uuid";

const router = Router();

router.get("/:id", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid document id" });
    return;
  }

  try {
    const result = await getDocumentWithPassages(req.params.id);
    if (!result) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as documentsRouter };
