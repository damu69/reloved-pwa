// Vercel entry point: every request (see vercel.json) is handed to the Fastify app. The app and its
// database pool are created once per function instance and reused across requests.
import { loadConfig } from "../dist/lib/config.js";
import { createPool } from "../dist/lib/db.js";
import { buildApp } from "../dist/app.js";

let ready = null;

async function init() {
  const cfg = loadConfig();
  const db = createPool(cfg);
  const app = await buildApp(cfg, db);
  await app.ready();
  return app;
}

export default async function handler(req, res) {
  if (!ready) ready = init().catch((err) => { ready = null; throw err; });
  let app;
  try {
    app = await ready;
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "API failed to start", err: String(err?.message ?? err) }));
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "NOT_READY", message: "The service is starting or misconfigured." } }));
    return;
  }
  app.server.emit("request", req, res);
}
