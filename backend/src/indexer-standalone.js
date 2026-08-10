// A standalone entry point that runs ONLY the indexer, no Express
// server. Lets you scale API servers horizontally without each one
// duplicating indexing work - run exactly one of these, separately,
// regardless of how many API server instances you run.
import { initDb } from "./db.js";
import { startIndexer } from "./indexer/index.js";

async function main() {
  await initDb();
  await startIndexer();
  console.log("[indexer-standalone] running as its own process");
}

main().catch((err) => {
  console.error("[indexer-standalone] fatal error:", err);
  process.exit(1);
});