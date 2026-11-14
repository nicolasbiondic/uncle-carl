#!/usr/bin/env bun
// scripts/ai-review.ts run | status | dry-run --casefile <path> [--models a,b,c]
// Entry point of the AI review on the dev machine; the logic and its tests are src/ai-review/app.ts. Normally
// started through scripts/ai-review.sh (lock, systemd scope, PATH).
import { dirname, join } from "node:path";
import { main } from "../src/ai-review/app";

const root = join(dirname(import.meta.path), "..");
process.exit(await main(process.argv.slice(2), process.env, root));
