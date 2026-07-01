# Research: Cloudflare platform feasibility for Onelight (July 2026)

Deep-research report, 2026-07-01. One of three reports underpinning `onelight_design_doc.md`. Facts were verified against Cloudflare documentation at research time; re-verify limits and pricing at Phase 5 start.

Bottom line: **the CF path is feasible and reasonably cheap** (~$60-90/mo for a small post house), with one architecture that works: **browser to presigned multipart upload to R2, R2 event notification to Queue, Worker consumer, Cloudflare Container running native ffmpeg, proxies back to R2, D1/DO for metadata + realtime**. What does *not* work: ffmpeg in Workers (WASM or otherwise), Media Transformations for anything bigger than 100 MB / longer than 60s output, proxying large uploads through a Worker (100 MB request body cap), and one-click provisioning of Containers via the Deploy button (not in the supported resource list - the main gap in the one-click story).

## 1. Video transcoding on Cloudflare today

### Cloudflare Containers - the only real option, and it's now GA
- **GA April 13, 2026** ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [InfoQ on the companion Sandboxes GA](https://www.infoq.com/news/2026/04/cloudflare-sandboxes-ga/)). Public beta was June 24, 2025 ([blog](https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable/)).
- **Runs arbitrary Docker images** - native ffmpeg works. `wrangler deploy` builds and pushes the image to Cloudflare's registry. Scale-to-zero via `sleepAfter`; instances are addressed through a Durable Object (`Container` class extends `DurableObject`) ([docs](https://developers.cloudflare.com/containers/)).
- **Instance types** ([limits](https://developers.cloudflare.com/containers/platform-details/limits/)): `lite` (1/16 vCPU, 256 MiB, 2 GB disk) up to `standard-4` (**4 vCPU, 12 GiB, 20 GB disk**). Custom instance types GA'd Jan 2026 but capped at the standard-4 ceiling. Account concurrency at GA: **1,500 vCPU / 6 TiB memory / 30 TB disk**. Image storage: 50 GB/account.
- **No GPU.** GPUs appeared in a 2023 preview blog ([blog](https://blog.cloudflare.com/container-platform-preview/)) but GA Containers has no GPU support and none announced ([Northflank comparison](https://northflank.com/blog/top-cloudflare-containers-alternatives)). H.264/HEVC software encode on <= 4 vCPU only - fine for review proxies (720p/1080p H.264), slow for 4K masters (expect well below realtime for 4K HEVC).
- **Hard constraint: 20 GB max disk, ephemeral.** Camera originals over ~15 GB can't be staged + transcoded on local disk. Mitigations: have ffmpeg read input via HTTP range directly from a presigned R2 URL, and stream output up via multipart. Disk, not CPU, is the limit for a post house.
- **Pricing** ([pricing](https://developers.cloudflare.com/containers/pricing/)): memory $0.0000025/GiB-s (provisioned), **CPU $0.00002/vCPU-s billed on active usage only** (Nov 2025 change - [changelog](https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/)), disk $0.00000007/GB-s (provisioned). Workers Paid ($5/mo) includes 25 GiB-hr memory, 375 vCPU-min, 200 GB-hr disk. Container egress: $0.025/GB NA/EU after 1 TB included. Requires Workers Paid; zero cost while asleep.
- **Caveats**: first deploy takes several minutes to provision ("calls to the Container will error" meanwhile - [get started](https://developers.cloudflare.com/containers/get-started/)); cold starts of seconds; no autoscaling primitives - you write scheduling logic in the Worker/DO yourself. Kent C. Dodds' production write-up of exactly this pattern (Queues to Worker to Container ffmpeg to R2, HMAC callback) is the best field report; his gotchas were container lifecycle (naive `sleepAfter` killed mid-job work; he added heartbeats + explicit stop) ([kentcdodds.com](https://kentcdodds.com/blog/offloading-ffmpeg-with-cloudflare)).

### Media Transformations - a preview/thumbnail tool, not a transcoder
- Limits ([docs](https://developers.cloudflare.com/stream/transform-videos/)): **input <= 100 MB and <= 10 min; output video 1-60 s max**, H.264/AAC MP4 in and out. Modes: `video` clip, `frame` (JPEG/PNG stills), `spritesheet`, `audio` (M4A extract).
- Since **March 2026 there's a Workers binding** (`env.MEDIA.input(stream)`) that works on private R2 objects ([changelog](https://developers.cloudflare.com/changelog/post/2026-03-18-media-transformations-workers-binding/)) - genuinely useful for **hover-scrub sprite sheets, filmstrips, poster frames, and audio extraction for transcription**, not for making review proxies of real footage.
- Pricing: $0.50/1,000 operations, 5,000 free/month; video/audio output costs 1 op per output second ([Stream pricing](https://developers.cloudflare.com/stream/pricing/)).

### Cloudflare Stream - viable as an optional managed backend
- **$5/1,000 min stored, $1/1,000 min delivered; encoding/ingest free** ([pricing](https://developers.cloudflare.com/stream/pricing/)). Per-minute (not per-GB) billing: for high-bitrate post-house masters this is actually favorable, but Stream is a delivery system, not archival storage - you'd still keep originals in R2 and use Stream purely for the HLS review proxy. It gives you ABR HLS/DASH, signed URLs, direct creator uploads (tus, up to 30 GB), webhooks, and a player. Ballpark: 400 h of proxies stored = 24,000 min = $120/mo, which is why most people building on R2 skip it and roll ffmpeg + HLS-in-R2.
- Sensible as a pluggable `TranscodeProvider`/`PlaybackProvider` for users who don't want Containers, but it creates a second player/URL model - cost of maintaining two paths.

### Workers themselves - confirmed: no
- 128 MB memory/isolate; CPU time 30 s default, 5 min max on paid; 10 MB gzip bundle cap; **runtime WASM compilation from bytes is blocked in workerd** - ffmpeg.wasm's ~31 MB core can't even load, and a real transcode would blow CPU and memory anyway ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [why ffmpeg.wasm dies in a Worker](https://rendobar.com/blog/ffmpeg-wasm-cloudflare-workers/)). WASM ffmpeg is a dead end even for "small" jobs. The community consensus pattern is Worker-as-front-door + native ffmpeg elsewhere (Containers, or an external box).

### What people actually do for transcode-on-R2-upload
The now-canonical architecture (used by Dodds and in CF's own guidance): client uploads direct to R2 via presigned multipart; **R2 event notification (`object-create`, fires on `CompleteMultipartUpload`) to Queue to Worker consumer**; Worker wakes a Container (or calls an external transcode box) with the object key; ffmpeg pulls from R2, writes proxy/HLS renditions + thumbnails back to R2; callback/queue message updates D1 and notifies the review-session DO. Before Containers GA, people pointed the queue consumer at Fly.io/VPS ffmpeg workers; that remains a valid escape hatch for 4K-heavy shops.

## 2. R2 - the strongest part of the story

- **Max object 5 TiB (4.995); single PUT <= 4.995 GiB; multipart up to 10,000 parts, 5 MiB-5 GiB each.** R2-specific gotcha: **all parts except the last must be the same size** (stricter than AWS S3) ([limits](https://developers.cloudflare.com/r2/platform/limits/), [upload docs](https://developers.cloudflare.com/r2/objects/upload-objects/)).
- **Presigned multipart from browser: yes.** S3 API supports `CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`; sign `UploadPart` URLs server-side (aws4fetch works inside Workers) and PUT parts directly from the browser - resumable, parallel, and it **bypasses the Worker 100 MB request-body cap** (Free/Pro plan limit; this is why you must not proxy uploads through the Worker) ([presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [Workers request limits](https://developers.cloudflare.com/workers/platform/limits/)). Incomplete multiparts auto-abort after 7 days (configurable lifecycle).
- **CORS**: per-bucket S3-style CORS config; must expose `ETag` (needed to complete multipart) and allow `PUT`/`Content-Type` ([troubleshooting](https://developers.cloudflare.com/r2/platform/troubleshooting/)).
- **Event notifications**: `object-create` (PutObject/CopyObject/CompleteMultipartUpload) and `object-delete` to **Cloudflare Queues** (Worker push consumer or HTTP pull). 100 rules/bucket, prefix/suffix filters, no overlapping rules; message carries bucket, key, size, eTag ([docs](https://developers.cloudflare.com/r2/buckets/event-notifications/)).
- **Egress: $0.** Free from S3 API, Workers API, and public/custom domains - the single biggest economic argument vs AWS for video ([pricing](https://developers.cloudflare.com/r2/pricing/)).
- **Range requests**: supported on all read paths (S3 API, Workers binding `get(key, {range})`, public buckets) - HLS segments and MP4 progressive playback with seek both work. Serve via **custom domain** (must be a zone on the same account) to get CDN caching, Cache Rules, WAF, and Access in front; `r2.dev` is rate-limited dev-only ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)). For private review links, either presigned GETs or a Worker that authenticates then streams from the binding (response body size is unenforced; cache limit 512 MB/object on non-Enterprise matters for caching big MP4s).
- **Pricing**: $0.015/GB-mo standard, $0.01 IA (+retrieval $0.01/GB, 30-day min); Class A $4.50/M, Class B $0.36/M; free tier 10 GB, 1M A, 10M B ([pricing](https://developers.cloudflare.com/r2/pricing/)).

## 3. Database: D1 vs alternatives

- **D1** ([limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/)): **10 GB max per database** (hard), 50,000 DBs/account, 1 TB total, 30 s max query, single-writer (sequential queries). Pricing is rows-scanned: first 25 B reads + 50 M writes/mo included on Paid, then $0.001/M reads, $1.00/M writes - for a review app this rounds to $0. **Verdict: comfortably sufficient.** Time Travel gives 30-day PITR. Weaknesses: no foreign data, single region (read replication via Sessions API exists), 100 columns/table, 2 MB max row.
- **Durable Objects + SQLite storage**: same price structure as D1 ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)); storage billing live since Jan 7, 2026 ($0.20/GB-mo past 5 GB, reads/writes like D1). Attractive pattern: one DO per project/review session holding its own SQLite (comments co-located with the websocket room). Cost: you must write your own cross-project query layer. A hybrid (D1 global catalog, per-session DO SQLite for hot comment state) is the idiomatic CF design but adds sync code.
- **Hyperdrive to external Postgres**: included in Workers plans, no extra charge; pools ~100 origin connections, query caching ([pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)). The portability play if self-hosted uses Postgres - but then one-click users must bring a Postgres. For true one-click, D1 is the only zero-external-dependency choice.

## 4. Durable Objects for realtime

- Exactly the intended use case. One DO per review session = WebSocket room with strong ordering; `state.storage` for playhead/presence; alarms for cleanup.
- **WebSocket Hibernation API is essential**: DO is evicted from memory between messages while sockets stay connected - no duration billing while idle. Incoming WS messages billed at a **20:1 ratio** (100 msgs = 5 request-equivalents); outgoing free; `setWebSocketAutoResponse()` handles pings for free ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- Pricing: $0.15/M requests + $12.50/M GB-s duration (billed at 128 MB) past included 1 M req / 400 K GB-s. A review room with sparse comment traffic and hibernation costs cents per month. Trap: outbound connections from the DO block hibernation and bill up to 15 min per connection.
- Free plan can use SQLite-backed DOs; hibernation works there too.

## 5. "Deploy to Cloudflare" button

- `https://deploy.workers.cloudflare.com/?url=<git-repo>` - clones the repo into the user's GitHub/GitLab, reads `wrangler.jsonc`, **provisions resources, binds them, sets up Workers Builds CI/CD and PR preview URLs** ([docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/), [launch changelog](https://developers.cloudflare.com/changelog/post/2025-04-08-deploy-to-cloudflare-button/)).
- **Can provision**: KV, D1, R2 buckets, Hyperdrive, Vectorize, Secrets Store secrets, **Durable Objects, Queues, Workers AI**. Secrets prompted from `.dev.vars.example`. D1 migrations can run via a custom deploy script in `package.json`.
- **Cannot (as of the current docs)**: **Containers and Workflows are absent from the supported list** - treat container provisioning via the button as unsupported. Also: public repos only, GitHub/GitLab cloud only, one Worker per button (monorepo = one button per subdir), Workers only (not Pages).
- **Consequence**: the one-click target can stand up everything except the ffmpeg container. Options: (a) ship one-click with Media Transformations thumbnails + originals-only playback and a documented `npx wrangler deploy` post-step (needs local Docker) that adds the transcode container; (b) make Stream the optional transcode backend for one-click users; (c) watch for Containers support in Workers Builds/deploy button - verify empirically before promising anything.
- R2 event-notification rules are created via wrangler/API, so include a `postdeploy` script that runs `wrangler r2 bucket notification create`.

## 6. One codebase, two targets

### TypeScript single codebase (recommended): Hono, hexagonal ports
- **Hono is the same code on both**: `export default app` on Workers; `serve(app)` via [`@hono/node-server`](https://github.com/honojs/node-server) on Node >= 20/Bun ([Hono docs](https://hono.dev/docs/getting-started/nodejs), [CF guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)). Web-standard Request/Response everywhere.
- The work is all in ports/adapters:
  - **Storage**: `BlobStore` - impls: R2 binding / S3 SDK (works against R2, MinIO, AWS) / local disk. Since R2 speaks S3, the S3 SDK impl alone can cover both targets (aws4fetch runs in Workers). Prior art: [hono-storage](https://github.com/sor4chi/hono-storage).
  - **DB**: Drizzle ORM runs the same schema on D1 (`drizzle-orm/d1`) and better-sqlite3/libsql or Postgres on Node. SQLite dialect both sides = minimal divergence.
  - **Jobs**: `JobQueue` port - CF Queues consumer export vs in-process worker/BullMQ on Node.
  - **Transcode**: `Transcoder` port - `spawn('ffmpeg')` on Node vs Container fetch (the same Docker image can serve as the self-hosted worker and the CF Container - write the ffmpeg job runner once as a small HTTP service).
  - **Realtime**: the genuinely annoying one. DO + hibernation WebSockets vs `ws` on Node have different lifecycles. Abstract at the room level (join/broadcast/state) and write two thin room hosts. Budget real effort here.
- **SvelteKit**: fully workable - one codebase, adapter chosen at build time (`adapter-cloudflare` vs `adapter-node`), bindings via `event.platform.env` on CF ([adapter-cloudflare docs](https://svelte.dev/docs/kit/adapter-cloudflare), [CF SvelteKit guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/sveltekit/)). Choose Hono API + separate SPA if you want the API to be the stable contract.
- Workers runtime `nodejs_compat` is good now (node:crypto, buffer, streams), so shared server code rarely hits runtime walls - the walls are the bindings, which the ports isolate.

### Go backend + thin Workers variant: honest assessment
- **Go does not run on Workers** in any production-credible way (TinyGo/WASM: no goroutine-heavy libs, size/CPU limits, syscall gaps). A "thin Workers variant" means rewriting the entire API surface in TS plus the DO realtime layer. You'd share only the frontend, the OpenAPI contract, and the ffmpeg container image. Expect 50-70% duplicated effort and permanent drift risk.
- Middle path worth knowing: run the whole Go app inside one always-ish-on Cloudflare Container behind a trivial proxy Worker. It "works" but: ephemeral disk (no local SQLite unless Litestream to R2), single-instance statefulness fights the platform, you pay for provisioned memory while awake, and one-click is still blocked on Containers-in-deploy-button. A shortcut, not a target architecture.
- **Verdict**: if CF one-click is a real product goal, pick the single-TS-codebase approach.

## 7. Cost estimate - small post house on the CF path

Assumptions: 2 TB in R2, 500 GB uploads/mo (~80-100 h of footage), transcode each upload to 1080p proxy + HLS + sprites on `standard-4` containers (~100 h container wall time/mo at ~50% avg CPU), 20 active reviewers, modest playback (~1.5 TB/mo egress from R2 custom domain).

| Item | Math | $/mo |
|---|---|---|
| Workers Paid base | flat (includes Workers, D1, DO, Queues allowances) | $5.00 |
| R2 storage | 2,048 GB x $0.015 | ~$30.70 |
| R2 Class A ops | ~50 K multipart parts + writes ~ 0.06 M x $4.50 | ~$0.30 |
| R2 Class B ops | ~5 M segment GETs (mostly CDN-cached) | ~$1.50 |
| R2 egress | free | $0 |
| Containers CPU | 4 vCPU x 360 K s x 50% x $0.00002 (active-use billing) | ~$14.40 |
| Containers memory | 12 GiB x 360 K s x $0.0000025 | ~$10.80 |
| Containers disk | 20 GB x 360 K s x $0.00000007 | ~$0.50 |
| Container egress | proxies to R2 within included 1 TB | ~$0 |
| Queues | ~100 K messages ($0.40/M ops, 3 ops/msg) | ~$0.10 |
| D1 + DO (comments, websockets, hibernated) | within included limits | ~$0-1 |
| Media Transformations (sprites/stills) | mostly within 5,000 free ops | ~$0-5 |
| **Total** | | **~$63-70/mo** |

Sensitivity: doubling transcode hours adds ~$26; storage dominates long-term and grows $15/TB/mo (move cold originals to Infrequent Access at $10/TB). The same footprint on S3+CloudFront would pay ~$46/mo storage plus ~$120+/mo egress - R2's free egress is the whole ballgame. Optional Stream backend instead of Containers: ~$120/mo per 400 h of stored proxies + $1/1,000 min viewed, zero transcode engineering.

### Key risks to design around
1. **20 GB container disk** vs large camera originals: stream-through ffmpeg (HTTP range input, multipart output), don't stage.
2. **100 MB Worker request body**: uploads must go direct-to-R2 presigned, never through the Worker.
3. **R2 multipart uniform-part-size rule**: fix part size client-side before starting.
4. **Deploy button can't provision Containers**: one-click tier ships degraded or with a documented post-step; keep the transcode path behind a `Transcoder` port.
5. **DO hibernation discipline** (no outbound sockets held open, use auto-response pings) or realtime costs jump ~100x.
