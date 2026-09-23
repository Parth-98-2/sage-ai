import dotenv from "dotenv";

dotenv.config();

import { createApp } from "./app";

const app = createApp();
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Sage backend listening on port ${port}`);
});
