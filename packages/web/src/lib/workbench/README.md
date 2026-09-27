# Library workbench

The private workspace shares a small set of controls and actions. Public shares
do not mount the palette, undo history, or personal preferences.

## Interaction

- Save a view to remember a folder, filters, sorting, grid/list layout, thumbnail
  size, density and visible metadata columns. Views can be renamed or deleted.
  Pin folders for direct access. These settings belong to the current user in
  this browser; they are not shared workspace policy.
- Space on an asset opens Quick Look. Previous/Next browse the current library
  order. Escape closes it without navigating the library. Inside the media
  player's controls, its normal frame-navigation shortcuts retain ownership.
- Cmd/Ctrl+K opens commands, project search and asset search. Arrow keys choose
  a result; Enter runs it. The palette also exposes relevant library actions.
- Cmd/Ctrl+Z or the recent-action Undo button reverses supported asset changes,
  version stacking and share ordering. Undoing a version upload moves it into
  a separate asset without deleting its media or notes. The review version menu
  also offers Unstack; Undo restores its original stack position and current
  version. Native text-field undo is never intercepted. Undo lives
  only in memory, holds 20 actions, and clears on account changes.
- Returning to a library restores its folder, selected assets, loaded position
  and panels. Review remembers version, paused integer frame, note filter and
  panel arrangement. Explicit frame/version URLs take priority.
- Display options control density, list columns and folder-panel width. Review
  offers a resizable notes panel and Focus mode. The inspector is shared across
  the library, Quick Look and review room.

## Boundaries

`library.ts` validates saved settings. `preferences.ts` handles fallible browser
storage; durable library settings are separate from the 60 most recent working
states, so reviewing a large delivery does not evict saved views. A library
restores at most 2,000 loaded assets and 500 selections, with a visible notice
when more pages remain. Each project supports 20 saved views and 20 folder pins.

Sorting and filters run on the API before pagination. Extended keyset cursors
bind their project, filters and ordering. Legacy API callers retain their
original ID-descending cursor contract. Virtualization remains in the library,
and Quick Look lazy-loads the existing media player.

`asset-actions.ts` builds reversible mutations. The API compares expected values
in the mutation's SQL predicate and returns the actual changed row. Undo cannot
overwrite an intervening change to the fields it owns. Trash uses a monotonic
tombstone; share ordering uses a single atomic guarded update. Partial batches
retain only transient failures for retry. `version-actions.ts` groups dependent
upload reversals by asset so a temporary failure preserves the remaining order
for retry. The server signs restoration details and checks the live stack before
moving versions; it refuses to discard intervening detached-asset changes.
Library uploads transfer immediately but wait for their initial filename check
before attachment. Match requests and attachments use bounded batches; a failed
or timed-out optional check releases the files as new assets. Later fingerprint
results cannot offer a decision for a file already being attached. Each delivery
gets its own decision without changing earlier choices.
Signed version restoration expires after seven days, even if a tab stays open.
Irreversible purges, new asset uploads and folder deletion are not advertised as
undoable. `undo.revision` refreshes the currently
mounted surface after success or conflict, including across navigation.

The inspector queries one asset at a time. Its context endpoint returns explicit
safe projections, at most 50 memberships and 50 retained activity records, with
overflow indicators. Membership is manager-only; other project viewers still
get metadata and recorded activity. Activity is not represented as a complete
audit log. The share-list query also enforces restricted-project membership.

Preview and review UI remain neutral grey. Native dialogs own focus and their
background is inert; global media shortcuts respect dialog ownership. Fonts and
assets remain self-hosted. No new runtime dependency or database migration is required.

## Verification

`e2e/workbench.e2e.mjs` exercises the real app with an isolated multi-page project,
including saved state, keyboard navigation, undo conflicts, account isolation and
phone layouts. API contracts in `library-workbench.ts` and `asset-inspector.ts`
cover pagination, authorization, safe projections and atomic undo. D1 has a
focused guarded-reorder dialect test. Existing precision media tests are retained.

`e2e/version-stack.e2e.mjs` covers real version uploads, reversible unstacking,
preserved bytes and notes, batch reversal and safe conflicts. Version-stack API
contracts cover permissions, token replay, concurrency and reference guards;
Node and D1 both prove atomic success, stale no-op and rollback behavior.
