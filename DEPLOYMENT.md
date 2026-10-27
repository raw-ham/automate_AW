# Vercel container deployment (website)

The Vercel project root must be the directory containing Dockerfile, vercel.json,
package-lock.json, apps/, packages/, and services/. If the Git repository contains
this entire directory as workforce-automation/, choose workforce-automation as
Root Directory; otherwise leave Root Directory at the repository root.

Use the Container framework preset. Clear previous Install Command, Build Command,
and Output Directory overrides. Dockerfile installs the entire npm workspace and
builds the website. Set PORT=3000 in Vercel so routing matches the container.

Configure the four NEXT_PUBLIC_FIREBASE_* values for the production build as well
as runtime. Dockerfile declares these as ARG and ENV because Next.js embeds public
client configuration during next build. Verify the container build receives these
arguments; runtime-only configuration cannot repair an already-built client bundle.
Never pass Firebase administrator private keys as Docker build arguments.

Runtime environment: DATA_MODE=firebase, FIREBASE_PROJECT_ID,
FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, LEADERSHIP_ALLOWED_EMAILS,
APP_BASE_URL=https://your-website-domain, WORKER_URL=https://your-render-worker.
Authorize the website domain in Firebase Authentication. Keep credentials out of Git.

Server 2 remains on Render. Dockerfile.worker now runs npm run worker continuously,
not worker:once. For a public Render service set WORKER_HOST=0.0.0.0 and
WORKER_PORT=10000. Keep its APP_BASE_URL pointed at the website.

Vercel Container Functions scale down when idle. Vercel Daemons is a separate beta
for continuous background processes; this project does not configure a daemon or
move the existing Render worker. Its report HTTP endpoints need their own routing
plan if the worker is migrated later.

Verification: check /api/health, Google sign-in, role dashboards, worker /health,
and report updates. A successful image build alone does not verify Firebase access.
