// Build on Vercel: compile, then (production deployments only) apply database migrations with the
// owner connection. If a migration fails the build fails and the previous version keeps running.
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
run("npm run build");
if (process.env.VERCEL_ENV === "production") {
  if (!process.env.MIGRATE_DATABASE_URL) throw new Error("MIGRATE_DATABASE_URL is not set");
  run("npm run migrate");
} else {
  console.log(`VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}: migrations skipped (production only).`);
}
