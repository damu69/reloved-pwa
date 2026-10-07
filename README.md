# Reloved Marketplace (PWA)

A marketplace for pre-owned items. The app in this folder (plain HTML, CSS and JavaScript) talks to the Reloved API in `server/` through `/api/v1`. Vercel forwards `/api/*` to the API project (see `vercel.json`), so the browser sees one site and the sign-in cookie stays first-party.

- `index.html`, `app.js`, `api.js`, `styles.css`, `sw.js`: the app. `api.js` is the API client (access token in memory, refresh cookie handled by the browser).
- `config.js`: API base path.
- `server/`: the API (Node.js, Fastify, Postgres on Supabase). See `server/README.md` and `server/docs/DEPLOY.md`.
- `db.js`, `schema.sql`, `security.sql`: the earlier prototype's data layer (Supabase `docs` table). Not used by the app any more; kept for reference. Safe to delete.

Not available yet in this version: selling (seller sign-up, listings, stock), seller orders, returns screens, admin screens, online payments, notifications. Chat, offers and reviews from the prototype are not part of this version.
