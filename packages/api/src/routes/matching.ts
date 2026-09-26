import {
  stackKeyOf,
  versionTokenOf,
  CONTENT_MATCH_MIN_MARGIN,
  SHOT_OVERLAP_MIN_MARGIN,
  hashBits,
  contentBits,
  bitDistance,
  AUDIO_MATCH_MAX_DISTANCE,
  MOTION_MATCH_MAX_DISTANCE,
  bitsContentDistance,
  CONTENT_MATCH_MAX_DISTANCE,
  bitsContentOverlap,
  SHOT_OVERLAP_MIN,
  sha256Hex,
} from "@onelight/core";
import {
  uploadSessions,
  assets,
  assetVersions,
  jobs,
} from "@onelight/db/schema";
import { inArray, and, eq, isNull } from "drizzle-orm";
import type { HashBits, ContentBits } from "@onelight/core";
import { requireAuth } from "../auth.js";
import { userFromContext, jsonBody } from "../helpers.js";
import { bodies } from "../schemas.js";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Access } from "../operation/access.js";

export const registerMatchingRoutes = (
  api: ApiRouter,
  env: AppEnv,
  { access }: { access: Access },
) => {
  const { requireProject } = access;

  // Version stacking: attach a completed upload as the next version of an
  // existing asset. Mirrors the initial attach (probe job, storage
  // accounting, project event) and optionally carries unresolved comments
  // forward from the version that was current until this call.
  /* Batch versioning: the second half of the complaint this work exists for.

     "When we make updates to a batch, I think you have to drag the version 2s
     on top of the version 1s and it takes a lot of time." For 1200 files it is
     not a workflow, it is a day of dragging.

     Two endpoints, deliberately separate. The match is a dry run that writes
     nothing and returns what it would do, so the uploader can say "1,187 of
     1,200 files match assets already here" before a byte moves. The batch is
     the commit, and it only ever does what it was told: the pairings come back
     from the client, so a person has seen them. */
  const matchUploadsToAssets = async (
    projectId: string,
    folderId: string | null,
    files: Array<{
      filename: string;
      relative_path?: string | undefined;
      upload_id?: string | undefined;
    }>,
  ) => {
    const keys = new Set(files.map((file) => stackKeyOf(file.filename)));
    /* What the uploads themselves are, where they have been fingerprinted.
       An upload is not a version yet, so its identity lives on the session. */
    const uploadIds = files
      .map((file) => file.upload_id)
      .filter((id): id is string => Boolean(id));
    const uploadRows = uploadIds.length
      ? ((await env.db
          .select({
            id: uploadSessions.id,
            projectId: uploadSessions.projectId,
            captureKey: uploadSessions.captureKey,
            contentHash: uploadSessions.contentHash,
            audioHash: uploadSessions.audioHash,
            motionHash: uploadSessions.motionHash,
            fingerprintState: uploadSessions.fingerprintState,
          })
          .from(uploadSessions)
          .where(inArray(uploadSessions.id, uploadIds))
          .all()) as Array<{
          id: string;
          projectId: string;
          captureKey: string | null;
          contentHash: string | null;
          audioHash: string | null;
          motionHash: string | null;
          fingerprintState: string;
        }>)
      : [];
    const uploadById = new Map(
      uploadRows
        .filter((row) => row.projectId === projectId)
        .map((row) => [row.id, row]),
    );

    /* One indexed query for the whole batch, whatever its size. */
    const candidates = (await env.db
      .select({
        id: assets.id,
        name: assets.name,
        stackKey: assets.stackKey,
        folderId: assets.folderId,
        currentVersionId: assets.currentVersionId,
      })
      .from(assets)
      .where(
        and(
          eq(assets.projectId, projectId),
          isNull(assets.deletedAt),
          inArray(assets.stackKey, [...keys]),
        ),
      )
      .all()) as Array<{
      id: string;
      name: string;
      stackKey: string;
      folderId: string | null;
      currentVersionId: string | null;
    }>;

    /* Tiers two and three need every asset in the project, not only the ones
       whose name already matched, and they need what each one's current
       version IS. One join, once per batch: the comparison itself is
       arithmetic over 64 bit strings, which is fast enough that no index
       beyond this is worth having at a project's scale. */
    const wantsFingerprint = [...uploadById.values()].some(
      (row) =>
        row.captureKey ?? row.contentHash ?? row.audioHash ?? row.motionHash,
    );
    const fingerprinted = wantsFingerprint
      ? ((await env.db
          .select({
            id: assets.id,
            name: assets.name,
            captureKey: assetVersions.captureKey,
            contentHash: assetVersions.contentHash,
            audioHash: assetVersions.audioHash,
            motionHash: assetVersions.motionHash,
          })
          .from(assets)
          .innerJoin(
            assetVersions,
            eq(assets.currentVersionId, assetVersions.id),
          )
          .where(and(eq(assets.projectId, projectId), isNull(assets.deletedAt)))
          .all()) as Array<{
          id: string;
          name: string;
          captureKey: string | null;
          contentHash: string | null;
          audioHash: string | null;
          motionHash: string | null;
        }>)
      : [];
    const byKey = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const list = byKey.get(candidate.stackKey) ?? [];
      list.push(candidate);
      byKey.set(candidate.stackKey, list);
    }
    /* ---- phase one: the name ----

       Unchanged, and still first: a name that matches is a decision somebody
       made on purpose. What is new is that a name match CLAIMS its asset, so
       nothing weaker can land on the same one later in the batch. */
    type Answer = {
      filename: string;
      upload_id?: string;
      stack_key: string;
      version_token: string | null;
      asset_id: string | null;
      asset_name: string | null;
      rule: string;
      distance?: number;
      share?: number;
      candidates: Array<{ asset_id: string; asset_name: string }>;
    };
    const answers = new Array<Answer | null>(files.length).fill(null);
    const claimed = new Set<string>();
    const unresolved: Array<{
      index: number;
      wire: Omit<Answer, "asset_id" | "asset_name" | "rule" | "candidates">;
      upload: (typeof uploadRows)[number] | undefined;
    }> = [];

    for (const [index, file] of files.entries()) {
      const key = stackKeyOf(file.filename);
      const pool = byKey.get(key) ?? [];
      const exact = pool.filter(
        (candidate) =>
          candidate.name.toLowerCase() === file.filename.toLowerCase(),
      );
      const inFolder = pool.filter(
        (candidate) => (candidate.folderId ?? null) === folderId,
      );
      /* Strongest first: the same name wins over the same key, and the same
         key in the folder you are uploading into wins over the same key
         anywhere. A tie at the strongest available level is a conflict. */
      const [rule, chosen] =
        exact.length > 0
          ? (["exact-name", exact] as const)
          : inFolder.length > 0
            ? (["stack-key-in-folder", inFolder] as const)
            : ([
                pool.some(
                  (candidate) =>
                    candidate.name.toLowerCase() !==
                    file.filename.toLowerCase(),
                )
                  ? "different-extension"
                  : "stack-key",
                pool,
              ] as const);
      const wire = {
        filename: file.filename,
        ...(file.upload_id ? { upload_id: file.upload_id } : {}),
        stack_key: key,
        version_token: versionTokenOf(file.filename),
      };
      if (chosen.length === 1) {
        const match = chosen[0] as (typeof candidates)[number];
        claimed.add(match.id);
        answers[index] = {
          ...wire,
          asset_id: match.id,
          asset_name: match.name,
          rule,
          candidates: [],
        };
        continue;
      }
      if (chosen.length > 1) {
        /* Never guess. Two assets with the same identity is exactly the case
           where stacking the wrong way costs someone a day of work. */
        answers[index] = {
          ...wire,
          asset_id: null,
          asset_name: null,
          rule: "ambiguous",
          candidates: chosen.map((candidate) => ({
            asset_id: candidate.id,
            asset_name: candidate.name,
          })),
        };
        continue;
      }
      unresolved.push({
        index,
        wire,
        upload: file.upload_id ? uploadById.get(file.upload_id) : undefined,
      });
    }

    /* ---- phase two: what the file IS ----

       The name said nothing, so ask the file. Five kinds of evidence, ranked,
       and the rank is the argument:

       CAPTURE (5) is exact: the instant a frame was taken plus the body that
       took it. Only a camera can produce it, and a render never can.

       AUDIO (4) answers a colour pass. A grade changes every pixel and not one
       sample of the audio.

       MOTION (3) answers the colour pass that arrives with NO audio, which is
       common. How much the picture changes from frame to frame over the whole
       clip is where the cuts are, and a grade cannot move a cut. Measured on
       real spots: a day-for-night look moves the positional hash 18 bits, past
       the picture threshold, while the motion contour barely moves at all.

       POSITION (2) is the picture itself, sample against sample. Enormously
       strong against unrelated content and useless between two frames of one
       burst, hence a margin rather than a threshold.

       FOOTAGE (1) is for the re-edit, where the positions no longer line up:
       how much of the material appears anywhere in the other cut.

       Then the part that makes weak evidence usable: this is decided for the
       BATCH, not one file at a time. Ten graded spots against ten assets is a
       pairing problem, and a pairing can be obvious even when no single
       distance is decisive. So a pair is taken only when it is mutually the
       best available on both sides by a margin, and taking it removes both
       from everything that follows. Nothing is ever taken by elimination
       alone: the absolute threshold for its tier still has to be cleared. */
    if (unresolved.length) {
      type Evidence = {
        assetId: string;
        assetName: string;
        rule: string;
        rank: number;
        /* Higher is better, comparable only within a rank. */
        score: number;
        margin: number;
        distance?: number;
        share?: number;
      };
      const RANK = {
        capture: 5,
        audio: 4,
        motion: 3,
        perceptual: 2,
        "shared-footage": 1,
      } as const;
      /* What "clearly better than the runner up" means, per tier. Capture keys
         are exact, so any second holder of the same key is a conflict; the
         contour tiers want a couple of bits of daylight; the picture tiers
         carry the margins they were measured with. */
      const MARGIN = {
        capture: 0.5,
        audio: 2,
        motion: 3,
        perceptual: CONTENT_MATCH_MIN_MARGIN,
        "shared-footage": SHOT_OVERLAP_MIN_MARGIN,
      } as const;

      /* Every hash is read once, not once per comparison.

         This is a product: three thousand delivered files against a three
         thousand file library is nine million comparisons inside one request,
         and measured, comparing them as hex strings costs 1.4 us each, which
         is thirteen seconds of a blocked event loop. Parsed to numbers up
         front, the same nine million comparisons are arithmetic. */
      type Signed = {
        id: string;
        name: string;
        captureKey: string | null;
        audio: HashBits | null;
        motion: HashBits | null;
        content: ContentBits | null;
      };
      const signed: Signed[] = fingerprinted.map((row) => ({
        id: row.id,
        name: row.name,
        captureKey: row.captureKey,
        audio: row.audioHash ? hashBits(row.audioHash) : null,
        motion: row.motionHash ? hashBits(row.motionHash) : null,
        content: row.contentHash ? contentBits(row.contentHash) : null,
      }));
      /* And a capture key is an exact match, so it is a lookup rather than a
         scan of every asset in the project. */
      const byCaptureKey = new Map<string, Signed[]>();
      for (const row of signed) {
        if (!row.captureKey) continue;
        const list = byCaptureKey.get(row.captureKey) ?? [];
        list.push(row);
        byCaptureKey.set(row.captureKey, list);
      }

      const evidenceFor = (
        upload: (typeof uploadRows)[number] | undefined,
      ): Evidence[] => {
        if (!upload) return [];
        const out: Evidence[] = [];
        const uploadAudio = upload.audioHash
          ? hashBits(upload.audioHash)
          : null;
        const uploadMotion = upload.motionHash
          ? hashBits(upload.motionHash)
          : null;
        const uploadContent = upload.contentHash
          ? contentBits(upload.contentHash)
          : null;
        /* A clip has a point per sample and a frame has one, and only a clip
           can share footage: a single frame has a position, which the tier
           above already judges. */
        const sharesFootage = (uploadContent?.length ?? 0) > 1;
        if (upload.captureKey)
          for (const row of byCaptureKey.get(upload.captureKey) ?? [])
            out.push({
              assetId: row.id,
              assetName: row.name,
              rule: "capture-time",
              rank: RANK.capture,
              score: 0,
              margin: MARGIN.capture,
            });
        for (const row of signed) {
          if (upload.captureKey && row.captureKey === upload.captureKey)
            continue;
          if (uploadAudio && row.audio) {
            const distance = bitDistance(uploadAudio, row.audio);
            if (distance <= AUDIO_MATCH_MAX_DISTANCE) {
              out.push({
                assetId: row.id,
                assetName: row.name,
                rule: "audio",
                rank: RANK.audio,
                score: -distance,
                margin: MARGIN.audio,
                distance,
              });
              continue;
            }
          }
          if (uploadMotion && row.motion) {
            const distance = bitDistance(uploadMotion, row.motion);
            if (distance <= MOTION_MATCH_MAX_DISTANCE) {
              out.push({
                assetId: row.id,
                assetName: row.name,
                rule: "motion",
                rank: RANK.motion,
                score: -distance,
                margin: MARGIN.motion,
                distance,
              });
              continue;
            }
          }
          if (uploadContent && row.content) {
            /* The ceiling lets this stop counting as soon as the answer cannot
               be inside the threshold, which is almost every pair. */
            const distance = bitsContentDistance(
              uploadContent,
              row.content,
              CONTENT_MATCH_MAX_DISTANCE,
            );
            if (distance <= CONTENT_MATCH_MAX_DISTANCE) {
              out.push({
                assetId: row.id,
                assetName: row.name,
                rule: "perceptual",
                rank: RANK.perceptual,
                score: -distance,
                margin: MARGIN.perceptual,
                distance,
              });
              continue;
            }
            if (sharesFootage) {
              const share = bitsContentOverlap(uploadContent, row.content);
              if (share >= SHOT_OVERLAP_MIN)
                out.push({
                  assetId: row.id,
                  assetName: row.name,
                  rule: "shared-footage",
                  rank: RANK["shared-footage"],
                  score: share,
                  margin: MARGIN["shared-footage"],
                  share: Math.round(share * 100),
                });
            }
          }
        }
        /* Strongest first, and only the strongest few are worth keeping: the
           rest are noise a person would never be shown. */
        out.sort((left, right) =>
          left.rank === right.rank
            ? right.score - left.score
            : right.rank - left.rank,
        );
        return out.slice(0, 8);
      };

      const evidence = new Map<number, Evidence[]>();
      for (const entry of unresolved)
        evidence.set(entry.index, evidenceFor(entry.upload));

      /* Every file's evidence for a given asset, so the asset side of the
         pairing can be judged as cheaply as the file side. */
      const rivalsFor = new Map<
        string,
        Array<{ index: number; item: Evidence }>
      >();
      for (const [index, list] of evidence)
        for (const item of list) {
          const rivals = rivalsFor.get(item.assetId) ?? [];
          rivals.push({ index, item });
          rivalsFor.set(item.assetId, rivals);
        }

      /* Stable matching, which is the honest way to answer a batch.

         Each file proposes to the asset it has the best evidence for. An asset
         holds the best proposal it has seen and turns the rest away; a file
         turned away proposes to its next candidate. It ends with no pair left
         wanting each other more than what they got, which is the property a
         per-file threshold cannot give you: ten graded spots against ten
         assets settle each other, and one file's second choice becomes its
         answer only once the file that really owned its first choice has it. */
      const holds = new Map<string, { index: number; item: Evidence }>();
      const nextOffer = new Map<number, number>();
      const looking = unresolved
        .map((entry) => entry.index)
        .filter((index) => (evidence.get(index) ?? []).length > 0);
      while (looking.length) {
        const index = looking.pop() as number;
        const list = evidence.get(index) ?? [];
        let at = nextOffer.get(index) ?? 0;
        while (at < list.length) {
          const item = list[at] as Evidence;
          at += 1;
          /* A name match already took this one, and a name beats evidence. */
          if (claimed.has(item.assetId)) continue;
          const held = holds.get(item.assetId);
          if (!held) {
            holds.set(item.assetId, { index, item });
            break;
          }
          const better =
            item.rank === held.item.rank
              ? item.score > held.item.score
              : item.rank > held.item.rank;
          if (better) {
            holds.set(item.assetId, { index, item });
            /* The one it displaced goes back to looking, from where it left
               off, which is what makes this terminate. */
            looking.push(held.index);
            break;
          }
        }
        nextOffer.set(index, at);
      }

      /* Then the part stable matching cannot judge: whether either side of a
         pair actually prefers it. A pairing is only evidence if somebody is
         distinguishable. If a file is within a hair of two assets and nothing
         else claimed the other one, the pairing is arbitrary and must be
         refused; the same on the asset's side, where two files fit equally
         well and only one can be right. This is what keeps a single renamed
         file among a burst of near-identical frames ambiguous, while letting a
         whole campaign settle. */
      const matchedFiles = new Set(
        [...holds.values()].map((held) => held.index),
      );
      const assigned = new Map<number, Evidence>();
      for (const [assetId, held] of holds) {
        const list = evidence.get(held.index) ?? [];
        const closeRival = list.find(
          (item) =>
            item.assetId !== assetId &&
            item.rank === held.item.rank &&
            held.item.score - item.score < held.item.margin,
        );
        /* The file cannot tell this asset from another one nobody wanted. */
        if (closeRival && !holds.has(closeRival.assetId)) continue;
        const closeClaimant = (rivalsFor.get(assetId) ?? []).find(
          (rival) =>
            rival.index !== held.index &&
            !matchedFiles.has(rival.index) &&
            rival.item.rank === held.item.rank &&
            held.item.score - rival.item.score < held.item.margin,
        );
        /* The asset cannot tell this file from another one left over. */
        if (closeClaimant) continue;
        assigned.set(held.index, held.item);
        claimed.add(assetId);
      }

      /* ---- and what to say about the rest ----

         Never a dead end. A file nobody could place comes back with the
         shortlist that was closest, so the answer is "pick one of these"
         rather than "no match": the evidence was real, it just was not
         decisive. Pending still wins, because the file has not been looked
         at yet and the answer would be a lie. */
      for (const entry of unresolved) {
        const taken = assigned.get(entry.index);
        if (taken) {
          answers[entry.index] = {
            ...entry.wire,
            asset_id: taken.assetId,
            asset_name: taken.assetName,
            rule: taken.rule,
            ...(taken.distance === undefined
              ? {}
              : { distance: taken.distance }),
            ...(taken.share === undefined ? {} : { share: taken.share }),
            candidates: [],
          };
          continue;
        }
        const list = evidence.get(entry.index) ?? [];
        const top = list[0];
        const shortlist = top
          ? list
              .filter((item) => item.rank === top.rank)
              .slice(0, 6)
              .map((item) => ({
                asset_id: item.assetId,
                asset_name: item.assetName,
              }))
          : [];
        if (entry.upload?.fingerprintState === "pending" && !shortlist.length) {
          answers[entry.index] = {
            ...entry.wire,
            asset_id: null,
            asset_name: null,
            /* Still being identified: the client is told to come back rather
               than told there is no match. */
            rule: "pending",
            candidates: [],
          };
          continue;
        }
        answers[entry.index] = {
          ...entry.wire,
          asset_id: null,
          asset_name: null,
          /* More than one asset fits the evidence: a conflict, with its
             candidates, which the person resolves in one click. */
          rule: shortlist.length > 1 ? "ambiguous" : "none",
          ...(top?.distance === undefined ? {} : { distance: top.distance }),
          ...(top?.share === undefined ? {} : { share: top.share }),
          candidates: shortlist,
        };
      }
    }

    return answers.map(
      (answer, index) =>
        answer ?? {
          filename: (files[index] as (typeof files)[number]).filename,
          stack_key: "",
          version_token: null,
          asset_id: null,
          asset_name: null,
          rule: "none",
          candidates: [],
        },
    );
  };

  /* Identifying an upload needs a decoder, so it happens in the worker, in
     batches. The match endpoint asks for what it is missing and answers with
     what it has; a client that cares about the other two tiers polls until
     nothing is pending. A file whose name already matched is never queued,
     because the answer is already known. */
  const FINGERPRINT_BATCH = 50;

  const requestFingerprints = async (
    projectId: string,
    workspaceId: string,
    uploadIds: string[],
  ): Promise<void> => {
    if (!uploadIds.length) return;
    const now = env.clock.now();
    for (let from = 0; from < uploadIds.length; from += FINGERPRINT_BATCH) {
      const slice = uploadIds.slice(from, from + FINGERPRINT_BATCH);
      const idempotencyKey = `fingerprint:${await sha256Hex(slice.join(","))}`;
      const existing = await env.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, idempotencyKey))
        .limit(1)
        .all();
      if (existing.length) continue;
      await env.db
        .insert(jobs)
        .values({
          id: env.ids.ulid(),
          kind: "fingerprint",
          payloadJson: JSON.stringify({
            workspace_id: workspaceId,
            project_id: projectId,
            upload_ids: slice,
          }),
          idempotencyKey,
          status: "queued",
          /* Someone is waiting on the answer to a question they just asked. */
          priority: 1,
          capabilityJson: "{}",
          maxAttempts: 3,
          attempts: 0,
          runAfter: now,
          createdAt: now,
          startedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          finishedAt: null,
          error: null,
          workerId: null,
        })
        .run();
    }
  };

  api.post("/projects/:id/versions/match", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "editor");
    const body = await jsonBody(c, bodies.versionMatchRequest);
    const items = await matchUploadsToAssets(
      projectId,
      body.folder_id ?? null,
      body.files,
    );
    /* Everything the name could not place, and whose bytes have not been
       looked at yet. */
    const waiting = items
      .filter((item) => item.rule === "pending")
      .map((item) => item.upload_id)
      .filter((id): id is string => Boolean(id));
    if (waiting.length)
      await requestFingerprints(projectId, actor.workspaceId, waiting);
    return c.json({
      items,
      matched: items.filter((item) => item.asset_id !== null).length,
      ambiguous: items.filter((item) => item.rule === "ambiguous").length,
      unmatched: items.filter((item) => item.rule === "none").length,
      /* Ask again when this is not zero: the other two tiers need the file
         to have been opened. */
      pending: waiting.length,
    });
  });
};
