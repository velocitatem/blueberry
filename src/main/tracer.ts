// Must be imported before any other module to instrument outgoing LLM calls.
// Load .env first so DD_* vars are available before tracer.init().
import * as dotenv from "dotenv";
import { join } from "path";
import tracer from "dd-trace";

dotenv.config({ path: join(__dirname, "../../.env") });

tracer.init({
  llmobs: {
    mlApp: process.env.DD_LLMOBS_ML_APP ?? "blueberry",
  },
});

export { tracer };
