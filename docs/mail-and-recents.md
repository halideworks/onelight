# The recent shelf, the badges, and the mail

Three things a review tool is judged on before anyone looks at a single frame:
whether you can get back to what you were doing, whether it tells you something
happened, and what its email looks like in a mailbox.

## Recent projects

frame.io puts a strip of small cards above the project list. It is worth having
for the reason any shortcut is: a list of forty projects sorted by activity is
not a list of the four you are actually working on.

"Recent" means two different things at once and a person means both:

- the job that **moved**, which the project's own event log already answers
  (`last_activity_at`), and
- the job you were **last in**, which nothing recorded.

So a row per person per project (`project_visits`, migration 0035) records the
second, and a card's recency is the **later of the two**. That puts the thing you
left an hour ago next to the thing somebody commented on while you were away,
which is the shelf being useful rather than being a second sort order. Each card
says which of the two reasons it is there -- "opened 3h ago" against "updated
20m ago" -- because "3h ago" on its own leaves you wondering whether that was
you or somebody else.

Two deliberate choices:

**The visit is a write the client makes on purpose**, `POST /projects/:id/opened`,
not a side effect of `GET /projects/:id`. A GET happens for polls, prefetches,
another tab, a search result; a recent list built out of those describes the
software's behaviour rather than the person's.

**Somewhere you have actually been beats somewhere that merely changed.** If any
project has been opened, only opened ones are eligible for the shelf. Without
that rule one busy project nobody has looked at fills all six slots.

The shelf hides itself below five projects, where it would only be the same list
twice, and it scrolls sideways rather than wrapping, because a shelf that wraps
is a list.

`last_opened_at` is per viewer and null for somebody who has never opened it.
It is nobody else's business where a person has been, and a contract test holds
that: the same project reads null for another member.

## Badges

The count on a project card is unread notifications for that project. It is also
the clear button, because a count you cannot dismiss from where you read it is a
count people learn to ignore. Opening a project clears its badge, which is what
a badge means; the notifications themselves stay in the list, marked read.

## The mail

Every message this system sent was a line of plain text and a bare URL:

```
Subject: Onelight: new comment

Looks good
Open in Onelight: https://.../projects/01J.../assets/01J...
```

That is machine output, and machine output gets filtered, ignored and
unsubscribed from. It also misses what mail is actually for here: a producer or
a client who never signs in still gets "somebody commented on your spot", and
that email **is** the product as far as they are concerned.

The rules the rewrite is built to, in `packages/core/src/email.ts`:

1. **Say the thing in the subject.** Not "Onelight: new comment" but
   "Priya Raman commented on NIKE_SPRING_30_v4.mov - Nike Spring 26". A subject
   that needs the body opened to mean anything has wasted the only guaranteed
   impression. Digests count instead: "1 mention, 1 failed upload and 3 more
   updates across 2 projects", two clauses and a remainder, because a subject is
   cut off around sixty characters and the third clause is the one nobody needed.
2. **The preheader is part of the subject.** Every inbox shows the first text in
   the body beside the subject line. Left alone that is "View in browser". Here
   it is the note itself.
3. **Show the content, not a pointer to it.** The comment's words are what the
   reader wants. Making them click to find out what was said is the whole
   failure of notification mail.
4. **One obvious action.** A linked headline per item and one button. The first
   draft had "Open it in Onelight" under every item AND on the button: five
   copies of the same instruction in a digest of five.
5. **Short, and honest about what it left out.** A digest is capped at twelve
   items and says "And 4 more updates, waiting in Onelight."
6. **No images, no web fonts, no tracking.** Posters live behind signed URLs
   that would either leak or break, so the design works in type alone. A
   self-hosted tool has no business phoning home either way.

Every message carries a real `text/plain` alternative written to be read, not as
an afterthought, and the HTML is tables with inline styles because that is what
mail clients render. The one `<style>` block carries a dark-mode override, which
the clients that support it read and the rest ignore.

The notification vocabulary is separate, in
`packages/core/src/notification-copy.ts`, so the subject and the body of the same
message cannot drift apart. Its rule: name the person, name the thing, say what
happened, in that order. An approval has two written sentence forms rather than
assembled fragments, which is how you avoid "Dana sent back for changes
SPOT_30". A failed upload says what to do about it, because a dead end with no
next step is why people mail support instead.

Notification payloads now carry `project_name`, injected once in
`createNotifications` rather than at each call site. It is the first thing a
person needs -- which job is this? -- and the old mail had no way to say it.

### What looking at it caught

The design was screenshotted in Chromium at 390px and 700px, in both colour
schemes, which found three things no assertion would have:

- **The page kept a light band in dark mode.** The dark rule was on `<body>`, but
  the wrapping table carried an inline `background:#f4f2ee` and an inline style
  beats a media query. The class had to go on the wrapper and its cell too.
- **The action appeared twice**, once as an item link and once as the button.
- **The context line rendered as a second heading**, bold and underlined,
  because the instant email was passing the meta line in as a headline.

All three are now asserted in the sweep's tests: one occurrence of the button
label, no linked meta line, and `ol-page` on more than one element.

### What looking at the shelf caught

Screenshotted on a throwaway stack with seven projects, three of them opened at
different times, in Firefox at 1280px and 390px:

- **The cards were empty rectangles.** `ProjectCover` is a block with no height
  of its own -- it fills the frame it is given, and the shelf's frame gave it
  none. The cards below work because they set the cover to full height; the
  shelf needed the same rule. Every DOM assertion passed while the shelf showed
  nothing, which is the same failure mode as the fade mask that hid three phone
  panels.
- **RECENT was jammed under the create form**, with no space above it.

Then the wiring no unit test can see, driven through a real browser: clicking a
project that had never been opened fires exactly one `POST .../opened`, and
going back to the list puts that project at the head of the shelf. Both are
asserted in the check rather than eyeballed.

## The follow-up pass

Six things, in the order they were worth doing.

**The bell showed no comment text.** There were two implementations of
"describe this notification", and the web one had drifted twice over: it said
"Approval updated on X" where the mail said "Dana approved X", and its detail
line read `body_text`, `body` or `excerpt` when the server has always written
`preview`. So the words were in the payload and nothing rendered them. The web
copy is gone; both read the core vocabulary now, and the unread dot takes its
colour from the same tone the mail uses, so a mention and a failed upload are
findable in a list of twenty without reading it.

**Badges counted only what the browser had loaded.** A project whose unread rows
had fallen past the newest page showed no badge at all. `notifications.project_id`
is a column now (0036, backfilled from the payload) with an index on
`(user_id, read_at, project_id)`, and `GET /notifications/badges` returns counted
totals. Clearing one is `POST /notifications/read {project_id}`: clearing the ids
a client happened to hold left the rest unread, so the number came straight back
on the next poll.

**A failed upload says why.** The reason lived only in the job row, so the mail
could offer sympathy and nothing else. The pump now stores a short line on the
version (`transcode_error`, 0036) through `failureReason`, which recognises the
common ffmpeg failures and gives each one a sentence with a next step in it. An
unrecognised failure keeps the worker's own words with the container paths taken
out and clipped to 180 characters: a path is meaningless to the reader and
nobody's business.

**Mail behaves like mail now.** `Message-ID` and `References` keyed on the asset,
so nine notes about one cut arrive as one conversation; `List-Unsubscribe` with
`List-Unsubscribe-Post` so Gmail and Outlook draw their own one-click control,
which is what stops people reporting the message as spam instead; and
`Auto-Submitted` so no out-of-office answers a robot. The unsubscribe URL takes
an unauthenticated POST, so its authority is a signed token rather than a
session, and the only thing it can do is set email to off. Signed in core,
because the API verifies and the sweep signs and two implementations of one
scheme is how they drift. The footer says replies are not read, because there is
no inbound mail and pretending otherwise wastes somebody's note.

**Notification preferences are three questions instead of one** (0037). A
default, per-kind overrides, and what hour the daily summary should arrive in the
reader's own day. The browser offers its own UTC offset the first time, because a
default of UTC puts a "morning" summary in the middle of somebody's night. The
daily gate is a clock rather than an age, so it also records when it last sent:
without that the sweep would send a fresh summary on every pass through that
hour. Two days of silence beats a summary at the wrong time, so an overdue
digest still goes out if the server was asleep at the hour.

**A share can be sent from Onelight.** Until now a link left by being pasted
into somebody else's mail client, which made the client's first impression
whatever that person typed at half past eleven at night. `POST /shares/:id/email`
renders it with everything else: what is in it, what they can do, when the link
stops working. The passphrase is never in the message and the form says so,
because a link and its password together is the password not existing. Manager
only, rate limited, and refused on a revoked share.

`notification_preferences` had to be rebuilt rather than altered, because "off"
joins a CHECK constraint on mode and SQLite cannot alter a constraint. The
symptom was a 500 from the unsubscribe endpoint and the test caught it before a
person could.

Driven through a real browser afterwards: the settings page keeps what it is
told across a reload, on all seven controls.
