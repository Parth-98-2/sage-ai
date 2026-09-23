import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const connectionString =
  process.env.NODE_ENV === "test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    process.env.NODE_ENV === "test"
      ? "TEST_DATABASE_URL is required when NODE_ENV=test"
      : "DATABASE_URL is required"
  );
}

export const pool = new Pool({ connectionString });
