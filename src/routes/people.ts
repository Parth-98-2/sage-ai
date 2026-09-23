import { Router } from "express";
import { getPersonWithSources } from "../catalog/repository";
import { isUuid } from "../utils/uuid";

const router = Router();

router.get("/:id", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid person id" });
    return;
  }

  try {
    const result = await getPersonWithSources(req.params.id);
    if (!result) {
      res.status(404).json({ error: "person not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as peopleRouter };
