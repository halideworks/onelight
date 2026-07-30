import { describe, expect, it } from "vitest";
import {
  clampQuote,
  escapeHtml,
  renderEmail,
  renderEmailHtml,
  renderEmailText,
} from "./email.js";
import {
  countPhrase,
  describeNotification,
  frameLabel,
} from "./notification-copy.js";
import type { EmailDocument } from "./email.js";

const doc = (overrides: Partial<EmailDocument> = {}): EmailDocument => ({
  subject: "Dana commented on SPOT_30_v3.mov",
  preheader: "Trim the head, it lands late",
  heading: "Dana commented on SPOT_30_v3.mov",
  workspace: "Halide",
  sections: [
    {
      items: [
        {
          headline: "Nike Spring · SPOT_30_v3.mov · at 00:00:12:00",
          quote: "Trim the head, it lands late",
          href: "https://onelight.test/projects/p1/assets/a1?f=288",
          tone: "note",
        },
      ],
    },
  ],
  action: {
    label: "Open it in Onelight",
    href: "https://onelight.test/projects/p1/assets/a1?f=288",
  },
  footer: ["You were sent this because you are on this project."],
  ...overrides,
});

describe("the email document", () => {
  it("puts the preheader where an inbox reads it, before anything else", () => {
    const html = renderEmailHtml(doc());
    const hidden = html.indexOf("Trim the head");
    const body = html.indexOf("Nike Spring");
    /* The inbox shows the first text in the document beside the subject. If
       the preheader is not first, the preview is whatever the layout happened
       to put there. */
    expect(hidden).toBeGreaterThan(-1);
    expect(hidden).toBeLessThan(body);
    expect(html).toContain("max-height:0");
  });

  it("says what was said, in both alternatives", () => {
    const rendered = renderEmail(doc());
    for (const body of [rendered.text, rendered.html]) {
      expect(body).toContain("Trim the head, it lands late");
      expect(body).toContain("SPOT_30_v3.mov");
      expect(body).toContain(
        "https://onelight.test/projects/p1/assets/a1?f=288",
      );
    }
    /* The text alternative is written to be read, not to be a fallback: no
       markup, no leftover HTML entities. */
    expect(rendered.text).not.toContain("<");
    expect(rendered.text).not.toContain("&amp;");
  });

  it("escapes what people typed, everywhere it appears", () => {
    const nasty = '<script>alert("x")</script> & "quotes"';
    const html = renderEmailHtml(
      doc({
        heading: nasty,
        preheader: nasty,
        sections: [
          { title: nasty, items: [{ headline: nasty, quote: nasty }] },
        ],
        footer: [nasty],
        action: { label: nasty, href: "https://x.test/?a=1&b=2" },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    /* Including inside an attribute, where a raw quote would end the
       attribute and everything after it would be markup. */
    expect(html).toContain("https://x.test/?a=1&amp;b=2");
    expect(escapeHtml('"')).toBe("&quot;");
  });

  it("survives having nothing to list, which is what a reset email is", () => {
    const rendered = renderEmail(
      doc({
        subject: "Reset your Onelight password",
        heading: "Reset your password",
        intro: "Set a new one within the hour.",
        sections: [],
        action: {
          label: "Choose a new password",
          href: "https://x.test/reset",
        },
        footer: ["If it was not you, nothing has changed."],
      }),
    );
    expect(rendered.html).toContain("Choose a new password");
    expect(rendered.text).toContain(
      "Choose a new password: https://x.test/reset",
    );
    /* No empty section furniture left behind. */
    expect(rendered.text).not.toContain("--  --");
  });

  it("keeps a quote to the length of a quote", () => {
    const long = `${"word ".repeat(200)}end`;
    expect(clampQuote(long).length).toBeLessThanOrEqual(240);
    expect(clampQuote(long).endsWith("…")).toBe(true);
    /* Newlines in a comment must not become a wall of blank lines. */
    expect(clampQuote("one\n\n\ntwo")).toBe("one two");
  });

  it("renders the text alternative in reading order", () => {
    const text = renderEmailText(
      doc({
        sections: [
          { title: "Nike Spring", items: [{ headline: "One" }] },
          { title: "Adidas", items: [{ headline: "Two" }] },
        ],
        more: "And 3 more updates, waiting in Onelight.",
      }),
    );
    expect(text.indexOf("Nike Spring")).toBeLessThan(text.indexOf("Adidas"));
    expect(text.indexOf("Two")).toBeLessThan(text.indexOf("And 3 more"));
  });
});

describe("how a notification reads", () => {
  const payload = {
    actor_name: "Dana",
    asset_name: "SPOT_30_v3.mov",
    project_name: "Nike Spring",
    preview: "Trim the head",
  };

  it("names the person, the thing, and what happened", () => {
    expect(
      describeNotification({ kind: "comment.created", payload }).headline,
    ).toBe("Dana commented on SPOT_30_v3.mov");
    expect(
      describeNotification({ kind: "comment.mention", payload }).headline,
    ).toBe("Dana mentioned you on SPOT_30_v3.mov");
    expect(
      describeNotification({ kind: "comment.reply", payload }).headline,
    ).toBe("Dana replied on SPOT_30_v3.mov");
    expect(
      describeNotification({
        kind: "version.created",
        payload: { ...payload, version_no: 4 },
      }).headline,
    ).toBe("Dana uploaded v4 of SPOT_30_v3.mov");
  });

  it("writes an approval as a sentence rather than assembling one", () => {
    const approved = describeNotification({
      kind: "approval.updated",
      payload: { ...payload, status: "approved" },
    });
    expect(approved.headline).toBe("Dana approved SPOT_30_v3.mov");
    expect(approved.tone).toBe("good");
    const changes = describeNotification({
      kind: "approval.updated",
      payload: { ...payload, status: "changes_requested" },
    });
    expect(changes.headline).toBe("Dana asked for changes on SPOT_30_v3.mov");
    /* The one status a reader has to act on gets the colour that says so. */
    expect(changes.tone).toBe("attention");
    /* And with nobody to name, it still reads as English. */
    expect(
      describeNotification({
        kind: "approval.updated",
        payload: { asset_name: "SPOT_30_v3.mov", status: "changes_requested" },
      }).headline,
    ).toBe("SPOT_30_v3.mov needs changes");
  });

  it("tells somebody what to do about a file that failed", () => {
    const failed = describeNotification({
      kind: "transcode.failed",
      payload: { asset_name: "SPOT_30.mov" },
    });
    expect(failed.headline).toBe("SPOT_30.mov could not be processed");
    expect(failed.tone).toBe("attention");
    /* A dead end with no next step is why people mail support instead. */
    expect(failed.quote).toContain("Re-upload");
  });

  it("counts a mixed digest with the loudest kind first", () => {
    expect(
      countPhrase([
        "comment.created",
        "comment.created",
        "comment.mention",
        "approval.updated",
      ]),
      /* Two clauses and a count, because a subject line is cut off around
         sixty characters and the third clause is the one nobody needed. */
    ).toBe("1 mention, 1 approval and 2 more updates");
    expect(countPhrase(["comment.created"])).toBe("1 comment");
    expect(countPhrase(["version.created", "version.created"])).toBe(
      "2 new versions",
    );
  });

  it("gives a frame a timecode somebody can type into a player", () => {
    expect(frameLabel(0)).toBe("00:00:00:00");
    expect(frameLabel(288)).toBe("00:00:12:00");
    expect(frameLabel(24 * 3661 + 5)).toBe("01:01:01:05");
  });
});
