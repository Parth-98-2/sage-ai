import { Router } from "express";
import { getSourceById, getSourceWithDetails, listDocumentSummariesForSource } from "../catalog/repository";
import { isUuid } from "../utils/uuid";

const router = Router();

router.get("/:id", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid source id" });
    return;
  }

  try {
    const result = await getSourceWithDetails(req.params.id);
    if (!result) {
      res.status(404).json({ error: "source not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/:id/documents", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid source id" });
    return;
  }

  try {
    const source = await getSourceById(req.params.id);
    if (!source) {
      res.status(404).json({ error: "source not found" });
      return;
    }
    const documents = await listDocumentSummariesForSource(req.params.id);
    res.json({ source_id: source.id, documents });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as sourcesRouter };
