import { describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { folders } from "@onelight/db/schema";
import { req } from "../harness.js";
import { createProject, grantRole, unique } from "../seed.js";
import type { SuiteContext } from "../context.js";

/** Deterministic RNG (mulberry32); the seed is printed on any failure. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface FolderRow {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
}

const MAX_DEPTH = 10;
const OPERATIONS = 200;
/* A small name pool induces sibling collisions on purpose. */
const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon"];

/**
 * Phase 0 T16 folder property test: apply random valid and invalid
 * create/move/rename/delete operations through real HTTP and re-verify the
 * tree invariants from the database after every operation.
 */
export const registerFolderPropertyDomain = (ctx: SuiteContext): void => {
  describe("folder tree properties", () => {
    it("holds tree invariants under 200 random operations", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const rngSeed =
        Math.floor(Date.now() % 0x7fffffff) ^
        Math.floor(Math.random() * 0x7fffffff);
      const rng = mulberry32(rngSeed);
      const pick = <T>(items: T[]): T | undefined =>
        items.length ? items[Math.floor(rng() * items.length)] : undefined;

      const projectA = await createProject(h, seed.admin, {
        name: unique("FolderPropA"),
      });
      const projectB = await createProject(h, seed.admin, {
        name: unique("FolderPropB"),
      });
      const projectIds = [projectA.id, projectB.id];
      await grantRole(h, seed.admin, projectA.id, seed.editor.id, "editor");
      await grantRole(h, seed.admin, projectB.id, seed.editor.id, "editor");

      const snapshot = async (): Promise<FolderRow[]> =>
        h.db
          .select()
          .from(folders)
          .where(inArray(folders.projectId, projectIds))
          .all();

      const checkInvariants = (rows: FolderRow[]): string | undefined => {
        const byId = new Map(rows.map((row) => [row.id, row]));
        const siblingKeys = new Set<string>();
        for (const row of rows) {
          // Sibling names are unique within (project, parent).
          const key = `${row.projectId}|${row.parentId ?? ""}|${row.name}`;
          if (siblingKeys.has(key)) return `duplicate sibling: ${key}`;
          siblingKeys.add(key);
          // Parent exists, stays in the same project, no cycles, depth <= 10.
          let depth = 1;
          const seen = new Set<string>([row.id]);
          let current = row.parentId;
          while (current) {
            const parent = byId.get(current);
            if (!parent) return `dangling parent ${current} of ${row.id}`;
            if (parent.projectId !== row.projectId)
              return `folder ${row.id} crosses projects via ${parent.id}`;
            if (seen.has(parent.id)) return `cycle through ${parent.id}`;
            seen.add(parent.id);
            depth += 1;
            if (depth > MAX_DEPTH)
              return `depth ${String(depth)} exceeds ${String(MAX_DEPTH)} at ${row.id}`;
            current = parent.parentId;
          }
        }
        return undefined;
      };

      // Seeded tree: a couple of roots and a chain in each project.
      for (const projectId of projectIds) {
        const root = await req(h, `/api/v1/projects/${projectId}/folders`, {
          cookie: seed.editor.cookie,
          json: { name: "seed-root" },
        });
        expect(root.status).toBe(201);
        const rootBody = (await root.json()) as { id: string };
        const child = await req(h, `/api/v1/projects/${projectId}/folders`, {
          cookie: seed.editor.cookie,
          json: { name: "seed-child", parent_id: rootBody.id },
        });
        expect(child.status).toBe(201);
      }

      const allowedStatuses = new Set([200, 201, 204, 400, 404, 409]);
      let rows = await snapshot();
      for (let op = 0; op < OPERATIONS; op += 1) {
        const context = `seed ${String(rngSeed)}, op ${String(op)}`;
        const roll = rng();
        let response: Response;
        let description: string;
        if (roll < 0.4 || rows.length === 0) {
          // Create: parent chosen across BOTH projects so cross-project
          // parents (invalid) and deep chains (depth pressure) both occur.
          const projectId = pick(projectIds) ?? projectA.id;
          const parent = rng() < 0.7 ? pick(rows) : undefined;
          const name = rng() < 0.7 ? (pick(NAMES) ?? "alpha") : unique("prop");
          description = `create ${name} in ${projectId} under ${parent?.id ?? "root"}`;
          response = await req(h, `/api/v1/projects/${projectId}/folders`, {
            cookie: seed.editor.cookie,
            json: { name, ...(parent ? { parent_id: parent.id } : {}) },
          });
        } else if (roll < 0.65) {
          // Move: parent may be null, itself, a descendant, or a folder
          // in the other project.
          const target = pick(rows);
          if (!target) continue;
          const parentRoll = rng();
          const parentId =
            parentRoll < 0.15
              ? null
              : parentRoll < 0.25
                ? target.id
                : (pick(rows)?.id ?? null);
          description = `move ${target.id} under ${parentId ?? "root"}`;
          response = await req(h, `/api/v1/folders/${target.id}`, {
            method: "PATCH",
            cookie: seed.editor.cookie,
            json: { parent_id: parentId },
          });
        } else if (roll < 0.85) {
          const target = pick(rows);
          if (!target) continue;
          const name = rng() < 0.7 ? (pick(NAMES) ?? "beta") : unique("ren");
          description = `rename ${target.id} to ${name}`;
          response = await req(h, `/api/v1/folders/${target.id}`, {
            method: "PATCH",
            cookie: seed.editor.cookie,
            json: { name },
          });
        } else {
          // Delete: occasionally a bogus id to cover the 404 path.
          const target =
            rng() < 0.9 ? pick(rows) : { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
          if (!target) continue;
          description = `delete ${target.id}`;
          response = await req(h, `/api/v1/folders/${target.id}`, {
            method: "DELETE",
            cookie: seed.editor.cookie,
          });
        }
        expect(
          allowedStatuses.has(response.status),
          `${context}: ${description} answered ${String(response.status)}`,
        ).toBe(true);
        rows = await snapshot();
        const violation = checkInvariants(rows);
        expect(
          violation,
          `${context}: ${description} broke an invariant: ${violation ?? ""}`,
        ).toBeUndefined();
      }
    }, 180_000);
  });
};
