import path from "node:path";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { ingestText } from "../ingestion/ingestionService";
import { decodeUtf8Strict } from "../ingestion/textNormalization";
import { ValidationError } from "../ingestion/types";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

/** Runs the multer upload, turning its errors into JSON responses. */
const uploadSingleFile: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `file exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit` });
      } else {
        res.status(400).json({ error: err.message });
      }
      return;
    }
    next(err);
  });
};

const router = Router();

router.post("/text-file", uploadSingleFile, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required (multipart field name: file)" });
    return;
  }

  const extension = path.extname(req.file.originalname).toLowerCase();
  if (extension !== ".txt" && extension !== ".md") {
    res.status(400).json({ error: "only .txt and .md files are supported" });
    return;
  }

  const defaultTitle = path.basename(req.file.originalname, extension);

  try {
    const result = await ingestText({
      rawText: decodeUtf8Strict(req.file.buffer),
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
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as ingestRouter };
