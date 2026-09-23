import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ingestText } from "../ingestion/ingestionService";
import { ValidationError } from "../ingestion/types";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = Router();

router.post("/text-file", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required (multipart field name: file)" });
    return;
  }

  const extension = path.extname(req.file.originalname).toLowerCase();
  if (extension !== ".txt" && extension !== ".md") {
    res.status(400).json({ error: "only .txt and .md files are supported" });
    return;
  }

  const rawText = req.file.buffer.toString("utf-8");
  const defaultTitle = path.basename(req.file.originalname, extension);

  try {
    const result = await ingestText({
      rawText,
      suggestedTitle: (req.body.title as string) || defaultTitle,
      sourceType: (req.body.sourceType as string) || "other",
      personName: req.body.personName as string,
      personRole: req.body.personRole as string | undefined,
      externalUrl: req.body.externalUrl as string | undefined,
      publishedAt: req.body.publishedAt as string | undefined,
      ingestionMethod: "text_upload",
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as ingestRouter };
