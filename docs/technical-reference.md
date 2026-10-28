# Allo Ops technical reference

A workforce operations platform with a public landing page, Google login and signup, immutable role profiles, manager and employee dashboards, recurring task cycles, evidence submission, manager acknowledgement, independent escalation processing and reporting.

## Project setup

Requires Node 22 LTS or newer. Install with `npm install`. Configure the shared root `.env`; both servers load it. `.env.example` documents every variable. Do not put administrator credentials in NEXT_PUBLIC variables or commit secrets.

The production application defaults to `DATA_MODE=firebase`. Firebase configuration must be added before authenticated workflows can run. There is no automatic fake login. Local test data and the file adapter are available only when explicitly setting `DATA_MODE=local` outside production.

1. Firebase Console: register a web application; add its public web values to NEXT_PUBLIC_FIREBASE_*.
2. Enable Authentication → Google, select a support email, and authorize `localhost` and `127.0.0.1` for local testing.
3. Create the default Firestore database in production mode. Deploy firebase/firestore.rules and firestore.indexes.json. Direct browser database access is denied; the API verifies sessions and authorizes each operation.
4. Configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in `.env`. Keep the private key's literal \n escapes, or quote a multiline value. Alternatively use GOOGLE_APPLICATION_CREDENTIALS pointing to a private service-account file. For hosted deployments prefer a managed runtime identity. Use separate service identities for web and worker, with Firestore data access and required Firebase Auth session permissions; avoid Owner/Editor credentials.
5. Add approved leadership addresses to LEADERSHIP_ALLOWED_EMAILS. Configure notification recipients separately with LEADERSHIP_NOTIFY_EMAILS. The role card selected on the public website does not grant leadership access. Existing roles cannot be changed by registration requests.
6. Set WORKER_API_TOKEN to a long random value. Set APP_BASE_URL and WORKER_URL to the correct environment addresses.
7. The current Server 2 runtime forces email delivery off. RESEND_API_KEY and EMAIL_FROM are provider configuration for a future deliberate delivery change; environment toggles alone do not enable sending.
8. Run `npm run dev` for Server 1 at http://127.0.0.1:3000, and `npm run worker` separately for Server 2 at http://127.0.0.1:3001. Server 2 scans every five minutes by default, even when no users are signed in. `npm run worker:once` executes one scheduled job.

`npm run check:config` lists missing settings without printing values. `npm run typecheck`, `npm test`, and `npm run build` validate the source. Tests use isolated temporary local databases and do not claim a Firebase, email or OAuth integration test.

## Routes

Public: `/`, `/login`, `/signup`, `/complete-profile`.

Manager: `/manager/dashboard`, `/manager/tasks`, `/manager/employees`, `/manager/reports`, `/manager/escalations`, `/manager/history`, `/manager/action/[escalationId]`.

Employee: `/employee/dashboard`, `/employee/tasks`, `/employee/tasks/[cycleId]`, `/employee/history`, `/employee/reports`.

Leadership: `/leadership/dashboard`, `/leadership/tasks`, `/leadership/employees`, `/leadership/escalations`, `/leadership/reports`, `/leadership/history`, `/leadership/settings`.

Authentication uses Google ID tokens exchanged for HTTP-only Firebase session cookies. Server-rendered route guards and API checks verify the trusted profile. New profiles reserve custom IDs transactionally. The server verifies recent Google authentication and verified email; leadership requires the configured allowlist. Manager assignment and employee completion checks are repeated inside database transactions.

## Architecture and workflow

Server 1 is Next.js. It owns authentication, assignment, task creation, completion submissions and explicit manager acknowledgement. It never runs scheduled scans. Server 2 is a standalone Node process exposing health and token-protected scan controls; it owns verification, recurrence, overdue detection, escalation, reporting and email outbox delivery. Both share the same domain package and database adapter.

Firestore collections: users, userIds, managerEmployeeAssignments, tasks, taskCycles, completionSubmissions, auditLogs, reports, escalationEvents, notificationOutbox, automationState, automationRuns, appConfig. A task master stores recurrence and its generation cursor. Occurrence IDs are deterministic and preserve previous cycles. Calendar recurrence retains the original anchor and local wall-clock hour. Weekend shifting is configurable; daily business recurrence advances through working days.

Employees submit an external ticket or a daily completion note once. Server 2 validates required submitted fields and marks completion with the real employee and timestamp. Evidence is self-reported: no WhatsApp/portal API verification is claimed. Platform task IDs cannot be submitted as external ticket IDs. Late completion and manager acknowledgement remain separate.

The first worker scan after deadline queues a manager alert. Missed acknowledgement escalates after 24 hours from actual provider acceptance. Unresolved work otherwise escalates at the third checkpoint, 24 hours apart. Leadership can configure these thresholds. Transactions, deterministic events, scan leases and a durable email outbox prevent routine duplicate work. Queueing is distinct from SENT. Delivery retries use exponential backoff and provider idempotency keys. Provider idempotency windows are finite; inspect ambiguous delivery failures before manual requeueing.

## Local test adapter

Set DATA_MODE=local only for isolated development/tests. It stores normalized collections in `.local/data.json`, shared by both processes using a filesystem transaction lock. Startup seeds four assigned employees and a fifth unassigned account. In this explicit mode only, `/api/demo-login` can select a test identity. Public production login remains Google-only, and production refuses the local adapter. Local notifications are marked LOCAL_PREVIEW and never sent. The default .env does not enable test identities.

## Reporting and Google Sheets

The web report follows manager → employee → occurrence and supports CSV export. The legacy Apps Script integration mirrors immutable row IDs to five sheet tabs using SHEETS_SYNC_TOKEN. The companion AppsScript project instead reads Server 2 with REPORT_API_TOKEN and adds Gemini analysis; see the main README. Sheets is organization-wide reporting; employees submit completion through their scoped web dashboard. Do not expose sheet access to the whole workforce or share with external submission addresses without explicit authorization.

## Deployment

Build with `npm run build` and run Server 1 on a Node-capable host. Run Server 2 as a long-lived process or schedule `worker:once` independently. Store runtime secrets in the host's secret manager. Firebase Spark can supply Auth/Firestore within its quotas; dynamic Google Cloud hosting and scheduling require billing and are not enabled here. The owner requested no billing upgrade. Server 1 is deployed at https://automate-aw-five.vercel.app; the owner reports Server 2 and Apps Script operating. See the main README for the current container setup.

## Verification boundaries

Automated local domain tests cover recurrence, employee ownership, proof validation, concurrent completion, manager assignment, acknowledgement separation and escalation deduplication. Live Firebase authorization, Google login, email receipt, and Sheets execution require your credentials and must be checked after configuration. For larger organizations add bounded query pagination, transactional report updates on every acknowledgement, immutable audit retention and provider delivery webhooks before operational rollout.

## Server 2 JSON report API

`GET http://127.0.0.1:3001/get-report` returns the current operational database report. It is independent of scheduled scans and does not change task state or send emails. Use `npm run worker` for both scheduled scans and reporting, or `npm run worker:report` for reporting only. In report-only mode scan controls reject requests.

Send `Authorization: Bearer <REPORT_API_TOKEN>` from the external service. The token is configured in the root `.env`; keep it server-side. This token permits reading organization-wide report data and cannot trigger scans or advance the test clock. `WORKER_API_TOKEN` is intentionally not accepted at `/get-report`. Requests without a valid report token return 401; `?key=<REPORT_API_TOKEN>` is also accepted for direct browser access. Duplicate key parameters are rejected.

Example for a shell where REPORT_API_TOKEN has already been loaded securely:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer $REPORT_API_TOKEN" \
  'http://127.0.0.1:3001/get-report?limit=100'
```

The response has `schemaVersion`, generation timestamps, `pageCounts`, `pagination`, and `data`. Data contains allowlisted fields from `users`, `tasks`, `taskCycles`, `completionSubmissions`, `escalationEvents`, `reports`, and `auditLogs`. Internal IDs preserve relationships. Credentials, authentication tokens, profile email fields, recipient fields, proof links, private configuration and email bodies are not exported. User-authored task descriptions, evidence and remarks remain untrusted data for downstream AI processing.

`limit` defaults to 100 records **per collection**, with a maximum of 500. If `pagination.hasMore` is true, fetch `/get-report?limit=100&cursor=<URL-encoded nextCursor>` until `nextCursor` is null. Completed collections return empty arrays on later pages. Merge records by collection and ID. `pageCounts` describes the current page, not global totals. Reads are live, not an atomic cross-collection snapshot; records may change while paginating. Do not treat this endpoint as a transactional backup.

Responses use `Cache-Control: no-store`. Database failures return 503 without leaking internal errors. Export scope is fixed, not an arbitrary collection browser.

The worker binds to `127.0.0.1` by default. A remote AI/automation service cannot reach your computer's localhost. For remote access deploy Server 2 behind HTTPS with `WORKER_HOST=0.0.0.0`, or use an authenticated HTTPS tunnel. Configure the external service with that HTTPS base URL and the report token. The report endpoint itself does not create hosting or third-party connections; deployments and Apps Script are configured separately. Server-to-server requests need no CORS allowance; do not put the organization-wide token into browser code.

Browser access: `http://127.0.0.1:3001/get-report?key=YOUR_REPORT_API_TOKEN`. Add `&limit=100` and `&cursor=...` as needed. Query tokens can appear in browser history and upstream URL logs; use Authorization headers for service integrations. Responses set Referrer-Policy: no-referrer and never include the key in JSON.

## Live report editing and synchronization

Open `http://127.0.0.1:3001/report-editor` and enter `REPORT_WRITE_TOKEN` from `.env` to edit; `REPORT_API_TOKEN` gives read-only viewing. The page supports autosave, explicit save, task search, review states, custom tags, mail markings, and audit history. It subscribes to `/report-events` for live database change notifications rather than continuously polling all records. Unsaved drafts are not replaced by incoming data. The editor removes a query key from its address bar after connecting; use the token input on a reload.

`GET /report-events?key=<read-or-write-token>` is a server-sent event stream. `report-changed` means the client should reload `/get-report`; `sync-error` indicates a database subscription problem. It sends no raw records or secrets. Streams send heartbeats, reconnect after interruption and rotate after ten minutes. Up to sixteen streams can be active per worker process.

### Edit contract for external services

`PATCH /reports/{cycleId}` accepts only `REPORT_WRITE_TOKEN`, via Authorization header or the `key` query parameter. A write token also grants report reads, but a read token cannot edit or control the worker. Only these annotations can be edited: `reportNote`, `reviewStatus` (UNREVIEWED, IN_REVIEW, REVIEWED, NEEDS_ACTION), and `customTags`. This analyst review state is independent of manager acknowledgement. Completion actors, evidence, deadlines, delivery history and task lifecycle status cannot be forged through the report editing endpoint.

```json
{
  "requestId": "unique-request-id-0001",
  "expectedRevision": 0,
  "changes": {
    "reportNote": "Follow up on the portal evidence",
    "reviewStatus": "NEEDS_ACTION",
    "customTags": ["follow-up", "portal"]
  }
}
```

Use the source cycle's `reportRevision`, or zero for an unedited cycle. Each accepted edit transaction updates the source `taskCycles` record and its derived `reports` record, increments the revision and appends a `REPORT_EDITED` audit event including before/after values and the server-configured integration actor. `REPORT_EDITOR_ID` identifies the integration; the client cannot impersonate an employee or manager. A stale revision returns 409 and preserves the current data. Reload and reconcile before retrying. Repeat an identical request with the same requestId after a network failure to retrieve the original result safely; reusing it with different content is rejected. Deduplication receipts are stored in private `reportMutations` documents, which are not exported.

Task creation, employee evidence submission, and manager acknowledgement now update their derived reports in the same transaction. Worker scans preserve report annotations and rebuild operational markings. Reports include `mailHistory`, `mailTags`, `markings`, and revision metadata. API schema version is 1.1; existing collection arrays and pagination remain available.

### Mailing explicitly disabled

Server 2 forces `EMAIL_DELIVERY_ENABLED=false` and `EMAIL_DRY_RUN=true` before running. No Resend send call is made by this runtime, including `worker:once`. It still computes overdue/checkpoint/SLA behavior, records notification intents and maintains the audit trail. New Firebase notification intents are `SUPPRESSED`, with no sent timestamp. Disabled-mail acknowledgement timing uses notification preparation time for workflow testing; it does not assert manager receipt. Leadership escalation preparation is tracked separately from actual delivery.

Examples of accurate report labels:

- `Pending mail to Rahul Mehta — mailing disabled`
- `Mail preview for Rahul Mehta — not sent`
- `Mail failed for Rahul Mehta`
- `Mailed Rahul Mehta` — only if a historical delivery event is actually SENT

No report editor or write request can mark an email as sent. Suppressed intents are not eligible for automatic delivery. Re-enabling real mailing is a separate future implementation/configuration change.

Run `npm run worker` to keep the five-minute scan loop, reporting, editing and live synchronization available. `npm run worker:report` retains a read/edit server without scheduled scans. For local operation the worker process and computer must remain running. The hosted setup uses an always-on Render service; see the main README.
# automate_AW
