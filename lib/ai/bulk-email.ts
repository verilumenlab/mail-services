import { leftoverPlaceholders } from "@/lib/bulk/placeholders";
import { plainBody } from "@/lib/email/emphasis";
import { containsPhrase, nameParts, validatePersonalization, type RecipientIdentity } from "./personalization";
import type { BuiltPrompt } from "./prompt";

export const NOT_AVAILABLE = "NOT_AVAILABLE";
export const BULK_PROMPT_MARKER = "<bulk_outreach_email>";

export interface BulkAiInput {
  /** Body after placeholder replacement and with the sender signature: the text the AI must stay faithful to. */
  renderedBody: string;
  /** Rendered fixed subject, or null when the AI writes the subject. */
  fixedSubject: string | null;
  aiBody: boolean;
  instructions: string | null;
  customerName: string;
  companyName: string;
  fromName: string | null;
  /** Other columns of this contact's row in the uploaded file. */
  extra: Record<string, string>;
}

const SYSTEM = `You add highlights to ONE business email for one contact. The sender's body is in <rendered_body>.
Return the body exactly as given. Every word, punctuation mark, line, and line break stays the same, in the same order. Do not correct, rephrase, add, or remove anything, including the greeting and the signature.
Your only change: wrap at most four short phrases a reader must not miss in **double asterisks**, such as the deadline, the required action, or the outcome. Never highlight a whole heading, a whole paragraph, or the signature. Keep any **double asterisks** already in the body.
Rules:
- Subject: state the purpose in a few plain words. No clickbait, emoji, exclamation marks, or shouted capitals. At most 12 words, no placeholders. If a fixed subject is given, return it unchanged.
- Use ONLY names and companies from <contact_details> and the body. Any value equal to ${NOT_AVAILABLE} is unknown: do not guess or invent it.
- Address this contact only. Never mention any other company or person.
- Return JSON only: {"subject": "...", "body": "..."}. No explanation.`;

export function buildBulkPrompt(input: BulkAiInput): BuiltPrompt {
  const ctx = {
    to_name: input.customerName,
    company_name: input.companyName,
    from_name: input.fromName?.trim() || NOT_AVAILABLE,
    ...Object.fromEntries(Object.entries(input.extra).map(([k, v]) => [k.slice(0, 100), v.slice(0, 5000)])),
  };
  const user = [
    BULK_PROMPT_MARKER,
    `<contact_details>\n${JSON.stringify(ctx, null, 2)}\n</contact_details>`,
    input.fixedSubject
      ? `<fixed_subject>\n${input.fixedSubject}\n</fixed_subject>\nReturn this subject unchanged.`
      : "Write the subject for this contact.",
    input.aiBody
      ? "Return the body exactly as given. Only add **double asterisks** around at most four short phrases the reader must not miss. Do not change any word."
      : "Return the body exactly as given.",
    input.instructions?.trim() ? `<sender_instructions>\n${input.instructions.trim()}\n</sender_instructions>` : "",
    `<rendered_body>\n${input.renderedBody}\n</rendered_body>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: SYSTEM, user };
}

export function extractBulkField(user: string, tag: "rendered_body" | "fixed_subject"): string {
  return user.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? "";
}

export function extractBulkContext(user: string): Record<string, string> {
  try {
    return JSON.parse(user.match(/<contact_details>\n([\s\S]*?)\n<\/contact_details>/)?.[1] ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function wordCount(s: string): number {
  return plainBody(s).trim().split(/\s+/).filter(Boolean).length;
}

function shoutedWords(text: string): string[] {
  return plainBody(text).match(/\b[A-Z]{4,}\b/g) ?? [];
}

/** A pasted mailbox line, not a sentence of the letter. "to present their work" is a sentence. */
function isMailboxChrome(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 180) return false;
  if (/ago\)/i.test(t) && t.length < 80) return true;
  if (/^[^<>\n]{0,80}<[^>\s>]+@[^>\s>]+>\s*$/.test(t)) return true;
  if (/^(from|to|cc|sent|date)\b/i.test(t) && t.length < 160 && !/[.!?]/.test(t)) {
    const words = t.split(/\s+/);
    const prose = /\b(present|explain|review|submit|complete|prepare|their|work|covering|following|please|must|will|should|after|before|about)\b/i.test(t);
    if (words.length <= 8 && !prose) return true;
  }
  if (/<[^>\n]+@[^>\n]+>/.test(t) && /\b(am|pm)\b/i.test(t)) return true;
  return false;
}

function stripMailboxChrome(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isMailboxChrome(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DEADLINE_PHRASE = /\b(?:before|by)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const MARKS = /\*\*[^*\n]{1,80}\*\*/g;
const MAX_ADDED_HIGHLIGHTS = 4;

function insideMark(text: string, index: number): boolean {
  return ((text.slice(0, index).match(/\*\*/g) ?? []).length % 2) === 1;
}

/**
 * The uploaded body with the phrases the model put in **double asterisks** bolded.
 * Only the marked phrases are used, and only where they appear word for word in the upload,
 * so the uploaded text never changes. The signature is never highlighted.
 */
export function applyHighlights(rendered: string, adapted: string, signature = ""): string {
  const sig = signature.trim();
  const cut = sig ? rendered.lastIndexOf(sig) : -1;
  let head = cut > 0 ? rendered.slice(0, cut) : rendered;
  const tail = cut > 0 ? rendered.slice(cut) : "";
  const phrases = [...new Set([...adapted.matchAll(MARKS)].map((m) => m[0].slice(2, -2).trim()))].filter((p) => p.length >= 3);
  let added = 0;
  for (const phrase of phrases) {
    if (added >= MAX_ADDED_HIGHLIGHTS) break;
    const at = head.indexOf(phrase);
    if (at < 0 || insideMark(head, at)) continue;
    head = `${head.slice(0, at)}**${phrase}**${head.slice(at + phrase.length)}`;
    added++;
  }
  return head + tail;
}

/** The uploaded body with its deadline in bold, used when the model's highlights cannot be kept. */
export function defaultHighlight(rendered: string): string {
  if (new RegExp(MARKS.source).test(rendered)) return rendered;
  return rendered.replace(DEADLINE_PHRASE, (phrase) => `**${phrase}**`);
}

/** One bold deadline when the model forgot the highlight markers. */
function ensureHighlight(text: string, signature: string): string {
  if (/\*\*[^*\n]{1,80}\*\*/.test(text)) return text;
  const sig = signature.trim();
  const hasSig = Boolean(sig) && text.endsWith(sig);
  const head = hasSig ? text.slice(0, -sig.length) : text;
  if (!DEADLINE_PHRASE.test(head)) return text;
  const marked = head.replace(DEADLINE_PHRASE, (phrase) => `**${phrase}**`);
  return hasSig ? `${marked.trimEnd()}\n\n${sig}` : marked;
}

/** Numbers that are part of the letter. A pasted mailbox time such as "3:04 PM (1 hour ago)" is not one. */
function requiredNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const line of plainBody(text).split("\n")) {
    if (isMailboxChrome(line)) continue;
    for (const n of line.match(/\d+(?:[./:-]\d+)*/g) ?? []) found.add(n);
  }
  return [...found];
}

function urlsIn(text: string): string[] {
  return plainBody(text).match(/https?:\/\/[^\s<>)\]]+/gi) ?? [];
}

const DATE_WORD_SOURCE = "\\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\\b";
const WEEKDAY_DEADLINE_SOURCE = "\\b(?:before|by)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b";
const CALENDAR_DATE = /\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i;
const FILE_NAME_SOURCE = "(?:^|[\\s\"'(])([\\w][\\w .()'’-]{0,70}?\\.(?:rar|zip|7z|pdf|docx?|xlsx?|pptx?|csv|txt))(?=$|[\\s,;:)\"'.])";

function linesOf(text: string): string[] {
  return plainBody(text).split("\n").filter((line) => !isMailboxChrome(line));
}

/** Weekday and month words. Lowercase "may" is the verb, so only "May" counts as a month. */
function dateWords(text: string): string[] {
  const found = new Set<string>();
  for (const line of linesOf(text)) {
    for (const match of line.matchAll(new RegExp(DATE_WORD_SOURCE, "gi"))) {
      const word = match[1] ?? "";
      if (word.toLowerCase() === "may" && word !== "May") continue;
      found.add(word.toLowerCase());
    }
  }
  return [...found];
}

function deadlinePhrases(text: string): string[] {
  const found = new Set<string>();
  for (const line of linesOf(text)) {
    for (const match of line.matchAll(new RegExp(WEEKDAY_DEADLINE_SOURCE, "gi"))) found.add(match[0].toLowerCase());
  }
  return [...found];
}

function sectionMarkers(text: string): string[] {
  const found = new Set<string>();
  for (const line of linesOf(text)) {
    for (const match of line.matchAll(/(?:^|\s)(\d{1,2})\.(?=\s)/g)) found.add(`${match[1]}.`);
  }
  return [...found];
}

function fileNamesIn(text: string): string[] {
  const found = new Set<string>();
  for (const line of linesOf(text)) {
    for (const match of line.matchAll(new RegExp(FILE_NAME_SOURCE, "gi"))) {
      const name = (match[1] ?? "").trim();
      if (name) found.add(name);
    }
  }
  return [...found];
}

/** Exclamation marks and all-caps words the draft did not already use. */
function toneProblems(draft: string, adapted: string): string[] {
  const problems: string[] = [];
  const text = plainBody(adapted);
  const draftMarks = (plainBody(draft).match(/!/g) ?? []).length;
  const adaptedMarks = (text.match(/!/g) ?? []).length;
  if (adaptedMarks > draftMarks) problems.push("Introduced an exclamation mark");
  const allowed = new Set(shoutedWords(draft));
  const extra = [...new Set(shoutedWords(text))].filter((word) => !allowed.has(word));
  if (extra.length) problems.push(`Shouted capitals: ${extra.slice(0, 3).join(", ")}`);
  return problems;
}

function preservedFacts(rendered: string, adapted: string): string[] {
  const problems: string[] = [];
  const next = plainBody(adapted);
  const missingNumber = requiredNumbers(rendered).find((n) => !next.includes(n));
  if (missingNumber) problems.push(`Missing number from the draft (${missingNumber})`);
  const nextUrls = urlsIn(next).map((u) => u.toLowerCase());
  const missingUrl = urlsIn(rendered).find((u) => !nextUrls.includes(u.toLowerCase()));
  if (missingUrl) problems.push(`Missing URL from the draft (${missingUrl})`);
  const lower = next.toLowerCase();
  const missingDate = dateWords(rendered).find((word) => !lower.includes(word));
  if (missingDate) problems.push(`Missing date from the draft (${missingDate})`);
  const missingDeadline = deadlinePhrases(rendered).find((phrase) => !lower.includes(phrase));
  if (missingDeadline) problems.push(`Missing deadline from the draft (${missingDeadline})`);
  const missingSection = sectionMarkers(rendered).find((marker) => !next.includes(marker));
  if (missingSection) problems.push(`Missing section from the draft (${missingSection})`);
  const missingFile = fileNamesIn(rendered).find((name) => !lower.includes(name.toLowerCase()));
  if (missingFile) problems.push(`Missing attachment name from the draft (${missingFile})`);
  return problems;
}

function insertBeforeSignature(text: string, signature: string, lines: string[]): string {
  if (!lines.length) return text;
  const block = lines.join("\n");
  if (signature && text.endsWith(signature)) return `${text.slice(0, -signature.length).trimEnd()}\n\n${block}\n\n${signature}`;
  return `${text.trimEnd()}\n\n${block}`;
}

/**
 * Keeps a professional rewrite. The exact signature is put back, and any link or
 * attachment name the rewrite dropped is put back in front of that signature.
 * A pasted mailbox time is not restored, and a weekday deadline is not turned into a date.
 */
export function finishRewrite(rendered: string, adapted: string, signature: string): string {
  const sig = signature.trim();
  let text = stripMailboxChrome(adapted);
  if (sig && !text.endsWith(sig)) {
    const email = sig.split("\n").map((l) => l.trim()).find((l) => l.includes("@"));
    if (email) {
      const lines = text.split("\n");
      const at = lines.findLastIndex((l) => l.includes(email));
      if (at > 0) {
        let cut = at;
        while (cut > 0 && lines[cut - 1].trim() && lines[cut - 1].trim().length < 80) {
          cut--;
          if (/regards|sincerely|thanks/i.test(lines[cut].trim())) break;
        }
        text = lines.slice(0, cut).join("\n").trimEnd();
      }
    }
    text = `${text}\n\n${sig}`;
  }
  const source = sig && rendered.trimEnd().endsWith(sig) ? rendered.trimEnd().slice(0, -sig.length) : rendered;
  const plain = plainBody(text).toLowerCase();
  const missing = [
    ...urlsIn(source).filter((u) => !plain.includes(u.toLowerCase())),
    ...fileNamesIn(source).filter((name) => !plain.includes(name.toLowerCase())),
  ];
  text = insertBeforeSignature(text, sig, missing);
  return ensureHighlight(text, sig);
}

/**
 * Notes for the reviewer. They do not reject a rewrite and they do not block approval.
 * A weekday deadline stays as written until the sender types a calendar date.
 */
export function bulkReviewNotes(body: string): string[] {
  const plain = plainBody(body);
  const notes: string[] = [];
  if (new RegExp(WEEKDAY_DEADLINE_SOURCE, "i").test(plain) && !CALENDAR_DATE.test(plain)) {
    notes.push("Confirm the calendar date for this deadline before sending.");
  }
  if (urlsIn(plain).length) notes.push("Open each link and confirm the recipient can access it.");
  if (fileNamesIn(plain).length) notes.push("Confirm the named file is attached before sending.");
  return notes;
}

/**
 * Checks a polished body against the sender's rendered draft. Wording may be corrected,
 * but the length stays close to the draft so sentences are neither added nor removed.
 * Pasted mailbox lines are not counted, because the polish removes them.
 */
export function bulkBodyProblems(rendered: string, adapted: string, recipientName?: string | null): string[] {
  const problems: string[] = [];
  const next = adapted.trim();
  if (!next) {
    problems.push("Body is empty");
    return problems;
  }
  const before = wordCount(linesOf(rendered).join("\n"));
  const after = wordCount(next);
  if (before > 0 && after < Math.ceil(before * 0.8)) problems.push(`Removed part of the draft (${after} words vs ${before})`);
  if (before > 0 && after > Math.max(before * 1.3, before + 8)) problems.push(`Added new text to the draft (${after} words vs ${before})`);
  const left = leftoverPlaceholders(next);
  if (left.length) problems.push(`Unreplaced placeholders: ${left.join(", ")}`);
  if (recipientName?.trim()) {
    const first = plainBody(next).trim().split("\n")[0] ?? "";
    if (!/^(dear|hello)\b/i.test(first)) problems.push("Does not open with a professional greeting");
    const usable = nameParts(recipientName).full.split(" ").filter((part) => part.replace(/\./g, "").length >= 3);
    const opening = plainBody(next).slice(0, 500);
    if (usable.length && !usable.some((part) => containsPhrase(opening, part))) {
      problems.push(`Does not address the recipient by name (${recipientName.trim()})`);
    }
  }
  problems.push(...toneProblems(rendered, next), ...preservedFacts(rendered, next));
  return problems;
}

export function bulkSubjectProblems(subject: string, draft = ""): string[] {
  const problems: string[] = [];
  const s = subject.trim();
  if (!s) problems.push("Subject is empty");
  if (s.length > 200) problems.push("Subject is longer than 200 characters");
  if (s.split(/\s+/).length > 16) problems.push("Subject is too long");
  const left = leftoverPlaceholders(s);
  if (left.length) problems.push(`Unreplaced placeholders: ${left.join(", ")}`);
  problems.push(...toneProblems(draft, s));
  return problems;
}

/** Leakage and identity checks reused from the personalised generator. */
export function bulkLeakProblems(
  content: { subject: string; body: string },
  self: { id: string; name: string; company: string; renderedBody: string; supplied?: string },
  peers: RecipientIdentity[],
): string[] {
  const nameInBody = self.renderedBody.toLowerCase().includes(self.name.split(/\s+/)[0]?.toLowerCase() ?? "");
  const companyInText = self.renderedBody.toLowerCase().includes(self.company.toLowerCase());
  return validatePersonalization(
    content,
    { id: self.id, email: "", name: nameInBody ? self.name : null, company: self.company, requireCompany: companyInText, suppliedText: [self.renderedBody, self.supplied].filter(Boolean).join("\n") },
    peers,
  ).problems;
}
