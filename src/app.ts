import express, { Request, Response } from "express";
import { ingestRouter } from "./routes/ingest";
import { documentsRouter } from "./routes/documents";
import { peopleRouter } from "./routes/people";
import { sourcesRouter } from "./routes/sources";
import { searchRouter } from "./routes/search";
import { answerRouter } from "./routes/answer";

export function createApp() {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  app.use("/ingest", ingestRouter);
  app.use("/documents", documentsRouter);
  app.use("/people", peopleRouter);
  app.use("/sources", sourcesRouter);
  app.use("/search", searchRouter);
  app.use("/answer", answerRouter);

  return app;
}
