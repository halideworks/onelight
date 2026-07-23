# Full application hardening audit

Date: 2026-07-23

Scope: the Node and Cloudflare API paths, database contracts and migrations,
local blob storage, upload and transfer flows, authentication, webhooks,
maintenance, the review player, responsive review UI, generated API artifacts,
dependencies, media QA and integration planning.

The audit began with a user report that L shuttle advanced picture and changed
speed while audio stayed silent across Chromium and Firefox on macOS and
Windows. The defect was isolated by comparing the forward-shuttle audio path
with ordinary space-bar playback. The review then widened to the rest of
the application. Every item below landed with a regression test or a direct
verification step.

## Findings and repairs

| ID | Severity | Finding | Repair and evidence |
|---|---:|---|---|
| PLAYER-01 | High | Forward L shuttle enabled pitch-preserving time stretch. A browser-specific failure in that processor could leave the decoded picture moving while its audio output stayed silent. | Forward shuttle now selects direct varispeed resampling before changing playback rate. Space and button playback restore pitch preservation. Transport unit tests cover mode transitions; the media QA harness measures decoded signal at 1x, 2x and 4x in Chromium and Firefox. |
| AUTH-01 | High | An internal commenter could add or delete an attachment on another author's comment after passing project-level comment permission. | Internal attachment POST and DELETE now require the comment author or a project moderator. Cross-user contract tests cover both routes. |
| AUTH-02 | High | OIDC auto-linking trusted an email claim without requiring `email_verified`. | A new identity can auto-link only from a verified email claim. A previously linked provider subject remains usable. Contract tests cover the rejection and linked-identity path. |
| AUTH-03 | Medium | Anonymous replies, approvals and attachment uploads lacked route-specific abuse limits. | Share-scoped limits now cover each mutation. Approval writes are idempotent, so repeated identical decisions do not send duplicate notifications. |
| DATA-01 | High | Comment attachment count and total-byte limits existed only as application checks, leaving concurrent writes able to exceed them. Attachment bytes also escaped project storage accounting. | Migration 0023 adds SQLite and D1 triggers for ten attachments, 25 MiB per file and 100 MiB per comment. Insert and delete triggers update project storage atomically. Tests exercise direct database writes as well as the HTTP routes. |
| DATA-02 | High | Request-transfer byte caps used a read-then-write check that concurrent uploads could race. A missing cap meant unlimited receipt growth. | Receipt insertion now crosses an atomic database trigger. Request transfers default to 1 TiB and reject caps above 10 TiB. A concurrent contract test proves that only the allowed receipt commits. |
| DATA-03 | Medium | Deleting a comment left its attachment blobs behind until reconciliation. Share viewers also lacked an attachment-delete contract. | Comment deletion removes its attachment blobs. Share viewers can remove an attachment from their own comment, and the generated OpenAPI contract includes the route. |
| UPLOAD-01 | High | Multipart endpoints accepted unbounded part numbers and completion lists. Completion trusted client order and omitted exact declared-size validation. | The public contract now caps uploads at 128 GiB, parts at 8,192 and each part at 5 GiB. Completion requires a unique contiguous sequence, matches persisted etags and sizes, orders parts server-side and requires the persisted total to equal the declared object size. |
| UPLOAD-02 | High | The local multipart adapter read each completed part into memory to hash it, then read it again to assemble the object. | Part upload hashes through a transform while streaming to a temporary file. Compact sidecar metadata serves list-parts. Completion streams each part once through a hash transform into the assembled temporary object. Legacy parts receive metadata on first read. |
| MAINT-01 | Medium | The reaper selected only stale pending and uploading sessions. Completed, quarantined and aborted rows accumulated, while garbage collection treated dead session keys as live references. | The reaper handles every state, ages completed rows from completion time and the remaining states from creation time, and protects only live or completed upload keys during reconciliation. A maintenance test covers all five states and a referenced completed object. |
| LIVE-01 | High | The SSE route wrote replay data and returned, so a standards-compliant event-stream client could lose live updates after connecting. | Requests carrying `Accept: text/event-stream` stay open, wake immediately on an in-process publish, send a 15 second cross-isolate heartbeat and continue from `Last-Event-ID`. The finite response remains available to contract clients without the event-stream accept header. |
| LIVE-02 | Medium | Share and transfer presence updated persistent rows on every authenticated read. | Presence writes are limited to one durable update per viewer every five minutes, with a conditional update protecting concurrent requests. |
| WEBHOOK-01 | High | Two schedulers could claim the same due delivery. The signature carried no timestamp, body reads were unbounded and the timeout ended after response headers. | Delivery claim uses a conditional update with `RETURNING`. Each request signs `unix_seconds.body` and sends the timestamp header. Response capture stops at 4 KiB, and the 15 second abort remains armed through body consumption. Concurrent delivery tests observe one outbound request. |
| PRIV-01 | Medium | Error and slow-request logs printed public share and transfer bearer slugs. | Request logging replaces those path segments with a fixed redaction before output. Unit tests cover internal paths and every public bearer shape. |
| CORRECT-01 | Medium | Approval updates sent notifications after repeated writes of the same status. | The route returns the existing decision when no row changed. Notification scheduling runs only after a committed status transition. |
| CORRECT-02 | Medium | The integration dry run still expected the retired `audio_peaks` rendition and would fail a healthy modern pipeline. | The assertion now expects `waveform_data`, matching the worker plan and generated media contract. |
| SERVER-01 | Medium | The Node server resolved `packages/web/build` against its process working directory. The monorepo `pnpm dev` command starts inside `apps/server`, so a valid production build could disappear. | The default web root resolves from `import.meta.url`. `WEB_ROOT` remains an explicit override. A built app was served and exercised from the monorepo dev command on Windows. |
| UI-01 | Medium | At 1024 px the notes header exceeded its rail, the page gained a horizontal scrollbar, and compact player controls were selected from viewport width rather than the player's narrower grid column. | The player is an inline-size container. Compact transport rules follow its actual width, the settings band fits beside the rail, and the notes header uses a two-row grid. The review page derives content height through flex layout instead of a hard-coded header subtraction. |
| UI-02 | Medium | Review fullscreen controls and the phone tool shelf used gradient paint despite the neutral review-room rule. | Fullscreen controls use one neutral translucent value and the phone mask gradient is gone. Computed-style checks found no gradients on the player, stage, transport or notes rail. |
| UI-03 | Low | Share attachment editing offered upload without removal, and its edit field lacked an accessible name. Search could start repeated full scans while a user typed. | Share comments expose attachment removal and label the edit field. Search submits explicitly, avoiding redundant scans during typing. |
| DEPS-01 | High | The dependency audit reported 18 advisories, including 8 high-severity findings. Workers Vitest also used a removed configuration API. | Hono, jose, Svelte, SvelteKit, Vitest, Wrangler, Drizzle, nodemailer and their affected transitive packages were upgraded. The Workers config uses the current Cloudflare plugin. The final audit reports zero advisories across 429 dependencies. |

## Contract decisions fixed by this audit

- Public upload maximum: 128 GiB.
- Multipart maximum: 8,192 parts, 5 GiB per part.
- Comment attachments: 10 files, 25 MiB per file, 100 MiB total.
- Request transfer default: 1 TiB.
- Request transfer maximum: 10 TiB.
- Presence persistence interval: five minutes.
- Webhook signature input: `<unix_seconds>.<raw_json_body>`.
- Webhook response preview: 4 KiB.
- Webhook delivery timeout: 15 seconds through body consumption.

The constants live in `packages/api/src/limits.ts`. Migration 0023 repeats the
values inside database triggers because the database must reject a racing or
non-HTTP writer by itself. The migration parity checks cover the embedded D1
copy.

## Verification

| Gate | Result |
|---|---|
| `pnpm lint` | Pass, zero warnings |
| `pnpm typecheck` | Pass |
| `pnpm format` | Pass |
| `pnpm test` | Pass, 32 files and 517 tests |
| `pnpm test:workers` | Pass, 2 files and 22 D1 tests |
| `pnpm db:check` | Pass |
| `pnpm openapi:check` | Pass |
| `pnpm web:check` | Pass, zero Svelte errors or warnings |
| `pnpm qa` | Pass, 6 files and 12 tests; WebKit skipped because it is absent on this machine |
| `pnpm --filter @onelight/web build` | Pass |
| `node scripts/integration-e2e.mjs --dry-run` | Pass |
| `pnpm audit --json` | Pass, zero known vulnerabilities |

The authenticated review room was exercised from the built SPA at 1440x900,
1024x768, 768x1024 and 390x844. Measurements covered document overflow, player
and rail bounds, transport bounds, internal settings overflow and computed
background paint. Screenshots were inspected at each size.

The local D1 test run prints an EPERM warning when Wrangler tries to write its
debug log outside the workspace sandbox. Both Workers test files and all 22
tests complete successfully; application output and test artifacts stay
inside the workspace.

## Remaining external checks

- The full compose integration run depends on a live API, worker, ffmpeg and
  blob stack. Its plan passes locally; CI owns the real pipeline run.
- WebKit media QA awaits a local WebKit installation. Chromium and Firefox
  cover the reported shuttle failure.
- Real NLE import round-trips and the remaining share-flow browser judgement
  stay in the v1 blocker list.
- Webhook delivery still resolves DNS through the host network stack. A
  DNS-rebinding-safe resolver remains in the hardening backlog.
