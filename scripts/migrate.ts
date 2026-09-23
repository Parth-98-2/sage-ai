import "dotenv/config";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`Schema applied to ${connectionString.replace(/:[^:@]+@/, ":***@")}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
