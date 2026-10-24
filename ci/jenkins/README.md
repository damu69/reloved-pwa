# Reloved testing with Jenkins

GitHub Actions (`server-ci`) keeps running on every push. Jenkins is an extra, heavier pipeline that also runs browser, security-scan and load tests.

## What the pipeline does (see `Jenkinsfile`)

1. API: typecheck and the 297 database-backed tests (Postgres sidecar container).
2. Scans: `npm audit`, gitleaks (secrets in code and git history), semgrep (code patterns, OWASP top ten).
3. Starts a throwaway copy of the app (`ci/jenkins/scripts/stack-up.sh`): fresh database, migrations, API on :4000, seed data, test web server on :5173 that copies the Vercel rewrites and security headers.
4. Browser tests (`e2e/`, Playwright): sign-up and sign-in, search, cart and checkout, last-piece rule, security headers, blocked folders, closed debug routes. Phone size and desktop size.
5. Load tests (`load/`, k6): 20 virtual users on catalogue and search with speed limits, and a password-guessing test that must be stopped by the rate limiter.
6. OWASP ZAP baseline scan of the web copy (reports warnings, does not fail the build yet).

Nothing here touches your live site, live database or any real keys. The test database is a container that is thrown away.

## One-time setup on your Windows PC

1. Install Docker Desktop and start it.
2. In a terminal: `cd ci\jenkins` then `docker compose up -d --build` (first build takes several minutes).
3. Open http://localhost:8080. Unlock with the password from `docker compose logs jenkins` (look for the long code between asterisks), choose "Install suggested plugins" (ours are already included), then create your admin user.
4. Add a GitHub token: Manage Jenkins, Credentials, Global, Add, type "Username with password", username = your GitHub name, password = a fine-grained token with read-only Contents access to this repo. Id: `github-reloved`.
5. New Item, name `reloved`, type Pipeline. Pipeline definition: "Pipeline script from SCM", Git, repository URL of the repo, credentials `github-reloved`, branch `*/main`, script path `Jenkinsfile`. Save, then Build Now.

Jenkins checks GitHub every 5 minutes and builds when something new is pushed. It only runs while your PC and Docker are on. To run it always, move the same `docker-compose.yml` to a small cloud server.

## Running the parts yourself

- Browser tests only: start the stack (needs Postgres and `psql`), then `cd e2e && npm ci && npx playwright install chromium && npx playwright test`.
- Open the last browser report: `npx playwright show-report results/html`.
- Load test: `k6 run -e BASE_URL=http://127.0.0.1:4000 load/smoke.js`.

## Notes

- The first Jenkins run may fail on semgrep or ZAP findings. Read `reports/` (Build, Artifacts), fix real issues, and suppress false ones deliberately.
- The pipeline files were written and checked for syntax, and the browser tests were run end to end against a local copy (32 of 32 passed). The Jenkins container, docker-in-docker steps and k6/ZAP runs have not been exercised yet; expect to adjust on the first run.
- The browser tests found one real bug already: the sign-up form lost the name and phone you typed. Fixed in `app.js`.
