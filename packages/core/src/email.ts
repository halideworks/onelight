/* ---- what Onelight's mail looks like ----

   Every message this system sends used to be a line of plain text and a bare
   URL. That reads as machine output, and machine output gets filtered, ignored
   and unsubscribed from. Mail is often the ONLY part of the product a client
   ever sees: a producer who never signs in still gets "someone commented on
   your spot", and that email is the product as far as they are concerned.

   So the rules this module is built to:

   1. SAY THE THING IN THE SUBJECT. Not "Onelight: new comment" but
      "Dana commented on SPOT_30_v3". A subject that needs the body opened to
      mean anything has wasted the only guaranteed impression.
   2. THE PREHEADER IS PART OF THE SUBJECT. Every inbox shows the first text in
      the body next to the subject line. Left alone it shows "View in browser"
      or the first nav link. Here it carries the note itself.
   3. SHOW THE CONTENT, NOT A POINTER TO IT. The comment's words are what the
      reader wants; making them click to find out what was said is the whole
      failure of notification mail.
   4. ONE OBVIOUS ACTION. A link per item and one button, not five buttons.
   5. SHORT. A digest is capped and says how much it left out. Nobody scrolls
      a digest.
   6. NO IMAGES, NO WEB FONTS, NO TRACKING. Posters live behind signed URLs
      that would either leak or break, so the design has to work in type
      alone; a self-hosted tool has no business phoning home either way.

   The HTML is tables and inline styles because that is what mail clients
   render: Outlook has no flexbox and Gmail strips <style> selectors it does
   not like. The one <style> block carries the dark-mode override, which the
   clients that support it read and the rest ignore. Every message also carries
   a real text/plain alternative written to be read, not as an afterthought. */

/** One thing that happened, as a person would tell it. */
export interface EmailItem {
  /** "Dana commented on SPOT_30_v3" -- a sentence, not a category. Optional
      because an instant email's heading already IS the sentence, and saying it
      twice is how notification mail gets long. */
  headline?: string | undefined;
  /** Where it happened: "Nike Spring - 00:00:12:04". */
  meta?: string | undefined;
  /** What was actually said, when there is something to quote. */
  quote?: string | undefined;
  /** Deep link straight to the frame, not to the dashboard. */
  href?: string | null;
  /** The colour of the rule beside it: what kind of thing this is. */
  tone?: "note" | "good" | "attention" | "quiet";
}

export interface EmailSection {
  /** A project name, when a digest spans more than one. */
  title?: string | undefined;
  items: EmailItem[];
}

export interface EmailDocument {
  subject: string;
  /** The line the inbox shows beside the subject. Never left to chance. */
  preheader: string;
  heading: string;
  intro?: string | undefined;
  sections: EmailSection[];
  /** The one button. */
  action?: { label: string; href: string };
  /** "and 6 more" -- said out loud rather than silently dropped. */
  more?: string | undefined;
  /** Why this arrived and how to change it. */
  footer: string[];
  /** The workspace this is about, shown small beside the wordmark. */
  workspace?: string | undefined;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const TONES: Record<NonNullable<EmailItem["tone"]>, string> = {
  note: "#b8894a",
  good: "#4d7d54",
  attention: "#a5605a",
  quiet: "#8a9096",
};

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* A quote is evidence, not an essay: enough to know whether it concerns you. */
export const clampQuote = (value: string, limit = 240): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
};

/* The headline IS the link. A row of "Open it in Onelight" under each of five
   items is five copies of the same instruction; a headline that goes where it
   says it goes needs no instruction at all. */
const headlineHtml = (item: EmailItem): string => {
  const words = escapeHtml(item.headline ?? "");
  return item.href
    ? `<a class="ol-link" href="${escapeHtml(item.href)}" style="color:#1b1e22;text-decoration:none;border-bottom:1px solid rgba(47,111,120,0.45);">${words}</a>`
    : words;
};

const itemHtml = (item: EmailItem): string => {
  const rule = TONES[item.tone ?? "quiet"];
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
        <tr>
          <td width="3" style="width:3px;background:${rule};border-radius:2px;">&nbsp;</td>
          <td style="padding:0 0 0 14px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
              ${
                item.headline
                  ? `<tr><td class="ol-strong" style="font:600 15px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1e22;">${headlineHtml(item)}</td></tr>`
                  : ""
              }${
                item.meta
                  ? `
              <tr><td class="ol-dim" style="padding:${item.headline ? "3px" : "0"} 0 0;font:400 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#6b7178;">${escapeHtml(item.meta)}</td></tr>`
                  : ""
              }${
                item.quote
                  ? `
              <tr><td style="padding:9px 0 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
                  <tr><td class="ol-quote" style="padding:10px 12px;background:#f1efe9;border-radius:6px;font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2b2f34;">${escapeHtml(clampQuote(item.quote))}</td></tr>
                </table>
              </td></tr>`
                  : ""
              }
            </table>
          </td>
        </tr>
      </table>`;
};

const sectionHtml = (section: EmailSection): string => `
      ${
        section.title
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
        <tr><td class="ol-kicker" style="padding:22px 0 10px;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.09em;text-transform:uppercase;color:#8a9096;">${escapeHtml(section.title)}</td></tr>
      </table>`
          : ""
      }
      ${section.items
        .map(
          (item, index) =>
            `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;"><tr><td style="padding:${index === 0 ? "0" : "18px"} 0 0;">${itemHtml(item)}</td></tr></table>`,
        )
        .join("")}`;

const buttonHtml = (action: { label: string; href: string }): string => `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:26px 0 0;">
        <tr><td class="ol-btn" style="background:#2f6f78;border-radius:8px;">
          <a href="${escapeHtml(action.href)}" style="display:inline-block;padding:11px 20px;font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;">${escapeHtml(action.label)}</a>
        </td></tr>
      </table>`;

/** The document as the HTML alternative. */
export const renderEmailHtml = (doc: EmailDocument): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(doc.subject)}</title>
<style>
  /* The clients that read this show the app's own ink; the rest keep paper. */
  @media (prefers-color-scheme: dark) {
    .ol-page { background:#0d1117 !important; }
    .ol-card { background:#131a24 !important; border-color:#263140 !important; }
    .ol-strong, .ol-head { color:#e8e4dc !important; }
    .ol-dim, .ol-kicker, .ol-foot { color:#93989e !important; }
    .ol-quote { background:#1a2330 !important; color:#d6d2ca !important; }
    .ol-link { color:#e8e4dc !important; border-bottom-color:rgba(90,168,177,0.5) !important; }
    .ol-btn { background:#48929b !important; }
    .ol-rule { border-color:#263140 !important; }
    .ol-mark { color:#93989e !important; }
  }
  @media (max-width:600px) {
    .ol-card { padding:22px 18px !important; }
    .ol-head { font-size:19px !important; }
  }
</style>
</head>
<body class="ol-page" style="margin:0;padding:0;background:#f4f2ee;">
<div style="display:none;font-size:1px;color:#f4f2ee;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(doc.preheader)}</div>
<table role="presentation" class="ol-page" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background:#f4f2ee;">
  <tr><td class="ol-page" align="center" style="padding:28px 14px 34px;background:#f4f2ee;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:560px;border-collapse:collapse;">
      <tr><td style="padding:0 0 14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
          <tr>
            <td class="ol-mark" style="font:600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.22em;text-transform:uppercase;color:#8a9096;">Onelight</td>
            <td class="ol-mark" align="right" style="font:400 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#8a9096;">${escapeHtml(doc.workspace ?? "")}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td class="ol-card" style="padding:28px 26px;background:#ffffff;border:1px solid #e3dfd7;border-radius:12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
          <tr><td class="ol-head" style="font:600 21px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1e22;">${escapeHtml(doc.heading)}</td></tr>${
            doc.intro
              ? `
          <tr><td class="ol-dim" style="padding:8px 0 0;font:400 14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#6b7178;">${escapeHtml(doc.intro)}</td></tr>`
              : ""
          }
          <tr><td style="padding:20px 0 0;">${doc.sections.map(sectionHtml).join("")}</td></tr>${
            doc.more
              ? `
          <tr><td class="ol-dim" style="padding:18px 0 0;font:400 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#6b7178;">${escapeHtml(doc.more)}</td></tr>`
              : ""
          }${
            doc.action
              ? `
          <tr><td>${buttonHtml(doc.action)}</td></tr>`
              : ""
          }
        </table>
      </td></tr>
      <tr><td style="padding:16px 4px 0;">
        ${doc.footer
          .map(
            (line) =>
              `<div class="ol-foot" style="font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#8a9096;">${escapeHtml(line)}</div>`,
          )
          .join("")}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>
`;

/** The same document as the text alternative, written to be read. */
export const renderEmailText = (doc: EmailDocument): string => {
  const lines: string[] = [doc.heading];
  if (doc.intro) lines.push("", doc.intro);
  for (const section of doc.sections) {
    if (section.title) lines.push("", `-- ${section.title} --`);
    for (const item of section.items) {
      lines.push("");
      if (item.headline) lines.push(item.headline);
      if (item.meta) lines.push(item.meta);
      if (item.quote) lines.push(`  "${clampQuote(item.quote)}"`);
      if (item.href) lines.push(`  ${item.href}`);
    }
  }
  if (doc.more) lines.push("", doc.more);
  if (doc.action) lines.push("", `${doc.action.label}: ${doc.action.href}`);
  if (doc.footer.length) lines.push("", "--", ...doc.footer);
  return `${lines.join("\n")}\n`;
};

export const renderEmail = (doc: EmailDocument): RenderedEmail => ({
  subject: doc.subject,
  text: renderEmailText(doc),
  html: renderEmailHtml(doc),
});
