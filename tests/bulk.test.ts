import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyHighlights, buildBulkPrompt, bulkBodyProblems, defaultHighlight, bulkLeakProblems, bulkReviewNotes, bulkSubjectProblems, extractBulkContext, extractBulkField, finishRewrite, NOT_AVAILABLE } from "@/lib/ai/bulk-email";
import { autoMapBulkColumns, BULK_HEADER_ALIASES, sanitizeBulkMapping } from "@/lib/bulk/fields";
import { detectPlaceholders, hasSenderPlaceholders, leftoverPlaceholders, renderBulkEmail, senderSignature, withSignature, type BulkSender } from "@/lib/bulk/placeholders";
import { bulkRowStatus } from "@/lib/bulk/status";
import { BULK_STEPS, isBulkStep, nextBulkStep } from "@/lib/bulk/steps";
import { validateBulkRows } from "@/lib/bulk/validate";
import { pdfPagesToRows, type TextPiece } from "@/lib/csv/pdf";
import { composeOutgoing } from "@/lib/email/compose";
import { prepareAttachment } from "@/lib/email/attachment";
import { htmlBody, letterPlain, plainBody } from "@/lib/email/emphasis";
import { buildMimeMessage } from "@/lib/email/mime";
import { isValidTimeZone, zonedDateTimeToUtc } from "@/lib/queue/schedule";
import { bulkCheckSchema, bulkSendSchema, bulkSettingsSchema, ccEmailsSchema, recipientEmailSchema } from "@/lib/validation/bulk";

const MAPPING = { company_name: "company_name", to_name: "to_name", from_name: "from_name", email: "email" };

const SENDER: BulkSender = {
  senderName: "Subhash Rao",
  designation: "Director, Test Solutions",
  companyName: "Acme ATE",
  email: "subhash@acme-ate.example",
  phone: "+91 98450 00000",
  website: "https://acme-ate.example",
};

const SIGNATURE = "Subhash Rao\nDirector, Test Solutions\nAcme ATE\n+91 98450 00000 | subhash@acme-ate.example\nhttps://acme-ate.example";

const BODY = `Hi [To Name],

I lead test solutions at Acme. We help teams like [Company Name] cut SLT time.

- AI-driven ATE pattern optimisation
- SLT yield analytics

Could we talk this week?

Best regards,`;

describe("contact file mapping and validation", () => {
  it("maps the four columns, including common aliases", () => {
    assert.deepEqual(autoMapBulkColumns(["Company", "To Name", "From", "Mail ID", "City"]), {
      company_name: "Company",
      to_name: "To Name",
      from_name: "From",
      email: "Mail ID",
    });
    assert.deepEqual(autoMapBulkColumns(["company_name", "customer_name", "email_id"]), { company_name: "company_name", to_name: "customer_name", from_name: "", email: "email_id" });
    assert.deepEqual(sanitizeBulkMapping({ to_name: "nope", company_name: "company" }, ["company"]), { company_name: "company", to_name: "", from_name: "", email: "" });
  });

  it("reports errors, warnings and duplicates, and keeps other columns as extra details", () => {
    const rows = [
      { company_name: "Nova Semi", to_name: "Priya Shah", from_name: "Subhash", email: " Priya@Nova.example ", city: "Pune" },
      { company_name: "Blank Co", to_name: "", from_name: "Subhash", email: "a@blank.example", city: "" },
      { company_name: "", to_name: "Ravi", from_name: "Subhash", email: "ravi@x.example", city: "" },
      { company_name: "Bad Co", to_name: "Bad Mail", from_name: "Subhash", email: "not-an-email", city: "" },
      { company_name: "Other", to_name: "Dup Mail", from_name: "Subhash", email: "priya@nova.example", city: "" },
      { company_name: "Quiet Labs", to_name: "No Mail", from_name: "Subhash", email: "", city: "" },
      { company_name: "Orbit", to_name: "Liam", from_name: "", email: "liam@orbit.example", city: "" },
      { company_name: "Orbit", to_name: "Liam", from_name: "", email: "liam@orbit.example", city: "" },
    ];
    const { rows: out, summary } = validateBulkRows(rows, MAPPING);
    assert.equal(out[0].email, "priya@nova.example");
    assert.equal(out[0].fromName, "Subhash");
    assert.deepEqual(out[0].extra, { city: "Pune" });
    assert.deepEqual(out[0].errors, []);
    assert.match(out[1].errors.join(), /To name is empty/);
    assert.match(out[2].errors.join(), /Company name is empty/);
    assert.match(out[3].errors.join(), /Invalid email format/);
    assert.match(out[4].errors.join(), /Duplicate email \(also on row 2\)/);
    assert.match(out[5].errors.join(), /Email is empty/);
    assert.match(out[6].warnings.join(), /From name is empty/);
    assert.match(out[7].errors.join(), /Duplicate of row 8/);
    assert.equal(summary.total, 8);
    assert.equal(summary.invalid, 6);
    assert.equal(summary.valid, 2);
    assert.equal(summary.duplicateEmails, 1);
    assert.equal(summary.duplicateRows, 1);
    assert.equal(summary.withWarnings, 2);
  });

  it("does not warn about from name when the file has no from column", () => {
    const { rows } = validateBulkRows([{ c: "Nova", n: "Priya", e: "p@nova.example" }], { company_name: "c", to_name: "n", from_name: "", email: "e" });
    assert.deepEqual(rows[0].errors, []);
    assert.deepEqual(rows[0].warnings, []);
  });
});

describe("contacts from a PDF", () => {
  const piece = (x: number, y: number, str: string): TextPiece => ({ x, y, width: str.length * 5, height: 10, str });

  it("reads a table under recognised headers", () => {
    const page = [
      piece(10, 700, "Company Name"),
      piece(150, 700, "To Name"),
      piece(260, 700, "From Name"),
      piece(370, 700, "Email"),
      piece(10, 680, "Nova Semi"),
      piece(150, 680, "Priya Shah"),
      piece(260, 680, "Subhash"),
      piece(370, 680, "priya@nova.example"),
      piece(10, 660, "Orbit Devices"),
      piece(150, 660, "Liam Chen"),
      piece(370, 660, "liam@orbit.example"),
    ];
    const parsed = pdfPagesToRows([page], BULK_HEADER_ALIASES);
    assert.deepEqual(parsed.headers, ["Company Name", "To Name", "From Name", "Email"]);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0]["Email"], "priya@nova.example");
    assert.equal(parsed.rows[1]["From Name"], "");
    assert.deepEqual(autoMapBulkColumns(parsed.headers), { company_name: "Company Name", to_name: "To Name", from_name: "From Name", email: "Email" });
  });

  it("falls back to lines with an email and rejects scanned PDFs", () => {
    const parsed = pdfPagesToRows([[piece(10, 700, "Nova Semi"), piece(150, 700, "priya@nova.example"), piece(10, 680, "Just a title")]], BULK_HEADER_ALIASES);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]["Column 2"], "priya@nova.example");
    assert.throws(() => pdfPagesToRows([[]], BULK_HEADER_ALIASES), /no selectable text/);
  });
});

describe("placeholders and the sender signature", () => {
  const recipient = { customerName: "Priya Shah", companyName: "Nova Semi" };

  it("fills placeholders, keeps the format and adds the signature after the sign-off", () => {
    const r = renderBulkEmail({ body: BODY, subjectTemplate: "AI ATE & SLT for [Company Name]", recipient, sender: SENDER });
    assert.deepEqual(r.problems, []);
    assert.equal(r.subject, "AI ATE & SLT for Nova Semi");
    assert.equal(r.body, `${BODY.replace("[To Name]", "Priya Shah").replace("[Company Name]", "Nova Semi")}\n${SIGNATURE}`);
    assert.deepEqual(leftoverPlaceholders(r.body), []);
  });

  it("uses the row's from name in the signature and leaves a gap when there is no sign-off", () => {
    assert.equal(senderSignature(SENDER, "Anita"), SIGNATURE.replace("Subhash Rao", "Anita"));
    assert.equal(withSignature("Hello there.\n", SENDER), `Hello there.\n\n${SIGNATURE}`);
    assert.equal(senderSignature({ senderName: "Solo", designation: null, companyName: null, email: null, phone: null, website: null }), "Solo");
    const r = renderBulkEmail({ body: "Hi [To Name], from [From Name]", subjectTemplate: "x", recipient: { ...recipient, fromName: "Anita" }, sender: SENDER });
    assert.ok(r.body.startsWith("Hi Priya Shah, from Anita"));
  });

  it("does not add a second signature when the body already has sender placeholders", () => {
    const body = "Hi [To Name],\n\nThanks,\n[Your Name]\n[Phone] | [Email]";
    assert.equal(hasSenderPlaceholders(body), true);
    assert.equal(hasSenderPlaceholders(BODY), false);
    const r = renderBulkEmail({ body, subjectTemplate: "x", recipient, sender: SENDER });
    assert.equal(r.body, "Hi Priya Shah,\n\nThanks,\nSubhash Rao\n+91 98450 00000 | subhash@acme-ate.example");
  });

  it("flags unsupported and empty placeholders instead of guessing", () => {
    const r = renderBulkEmail({ body: "Hi [To Name], see [Budget]. [Designation]", subjectTemplate: "Hello", recipient, sender: { ...SENDER, designation: null } });
    assert.match(r.problems.join(), /Unsupported placeholder \[Budget\]/);
    assert.match(r.problems.join(), /Sender designation is not set/);
    const empty = renderBulkEmail({ body: " ", subjectTemplate: " ", recipient, sender: SENDER });
    assert.match(empty.problems.join(), /body is empty/);
    assert.match(empty.problems.join(), /subject is empty/);
  });

  it("detects placeholders with their meaning", () => {
    const found = detectPlaceholders("[To Name] [Your Name] [Foo] [Customer Name] [From Name]");
    assert.equal(found.length, 5);
    assert.equal(found.find((f) => f.token === "[Foo]")?.key, null);
    assert.equal(found.find((f) => f.token === "[To Name]")?.key, "customer");
    assert.equal(found.find((f) => f.token === "[From Name]")?.key, "fromName");
  });

  it("uses the same signature for every row and never mixes recipients", () => {
    const people = [
      { customerName: "Priya Shah", companyName: "Nova Semi" },
      { customerName: "Liam Chen", companyName: "Orbit Devices" },
      { customerName: "Ana Ruiz", companyName: "Delta Fab" },
    ];
    const out = people.map((p) => renderBulkEmail({ body: BODY, subjectTemplate: "Hi [Company Name]", recipient: p, sender: SENDER }));
    assert.ok(out.every((o) => o.body.endsWith(SIGNATURE)));
    out.forEach((o, i) => {
      assert.ok(o.body.includes(people[i].customerName));
      for (const [j, other] of people.entries()) {
        if (j === i) continue;
        assert.ok(!o.body.includes(other.customerName), `row ${i} leaked ${other.customerName}`);
        assert.ok(!o.subject.includes(other.companyName));
      }
    });
  });
});

describe("AI checks", () => {
  const rendered = renderBulkEmail({ body: BODY, subjectTemplate: "x", recipient: { customerName: "Priya Shah", companyName: "Nova Semi" }, sender: SENDER }).body;

  it("accepts polished wording and rejects a body that drops or adds sentences", () => {
    assert.deepEqual(bulkBodyProblems(rendered, rendered), []);
    const polished = rendered.replace("Hi Priya Shah,", "Dear Priya,").replace("Could we talk this week?", "Could we speak this week?");
    assert.deepEqual(bulkBodyProblems(rendered, polished), []);
    assert.deepEqual(bulkBodyProblems(rendered, rendered.replace("this week", "**this week**")), []);
    assert.match(bulkBodyProblems(rendered, "Dear Priya, could we talk?").join(), /Removed part of the draft/);
    const offer = "We also offer a free audit, a pilot, and a discount to every customer this quarter.";
    assert.match(bulkBodyProblems(rendered, `${rendered}\n\n${offer}`).join(), /Added new text/);
    assert.match(bulkBodyProblems(rendered, rendered.replace("Nova Semi", "[Company Name]")).join(), /Unreplaced placeholders/);
  });

  it("validates subjects", () => {
    assert.deepEqual(bulkSubjectProblems("Cutting SLT time at Nova Semi"), []);
    assert.match(bulkSubjectProblems("").join(), /empty/);
    assert.match(bulkSubjectProblems("Hello [Company Name]").join(), /placeholders/);
    assert.match(bulkSubjectProblems("PLEASE read this now").join(), /Shouted capitals/);
    assert.match(bulkSubjectProblems("Update for Nova Semi!").join(), /exclamation mark/);
    assert.deepEqual(bulkSubjectProblems("Update for Nova Semi!", "Please reply!"), []);
  });

  it("requires a greeting and keeps numbers and links from the draft", () => {
    const polished = rendered.replace("Hi Priya Shah,", "Dear Priya,");
    assert.deepEqual(bulkBodyProblems(rendered, polished, "Priya Shah"), []);
    assert.match(bulkBodyProblems(rendered, rendered, "Priya Shah").join(), /professional greeting/);
    assert.match(bulkBodyProblems(rendered, rendered.replace("98450", "the office line"), "Priya Shah").join(), /Missing number/);
    assert.match(bulkBodyProblems(rendered, rendered.replace("https://acme-ate.example", "our website").replace("Hi Priya Shah,", "Dear Priya,"), "Priya Shah").join(), /Missing URL/);
  });

  it("keeps a rewrite that drops a pasted mailbox time and puts the signature and link back", () => {
    const signature = "Subhash Rao\nsubhash@acme-ate.example";
    const draft = `3:04 PM (1 hour ago)\nto nithin, me\n\nDear Priya,\n\nPlease review 9 datasets before Friday.\n\nhttps://drive.google.com/file/d/abc/view\n\n${signature}`;
    const rewritten = "Dear Priya,\n\nPlease review the 9 datasets and submit before Friday.\n\nKind regards,\nSomeone Else";
    const done = finishRewrite(draft, rewritten, signature);
    assert.ok(done.endsWith(signature));
    assert.match(done, /https:\/\/drive\.google\.com\/file\/d\/abc\/view/);
    assert.doesNotMatch(done, /3:04/);
    assert.deepEqual(bulkBodyProblems(draft, done, "Priya").filter((p) => /3:04|Missing URL|Missing number/.test(p)), []);
  });

  it("keeps a sentence that starts with to, and drops pasted mailbox lines", () => {
    const signature = "Subhash Rao\nsubhash@acme-ate.example";
    const draft = `subhan <subhan@example.com>\n3:04 PM (1 hour ago)\nto nithin, me\n\nDear Priya,\n\nto present and explain their work, covering the 3 points before Friday.\n\n${signature}`;
    const kept = draft.replace("the 3 points", "the points").replace("3:04 PM (1 hour ago)\n", "");
    assert.match(bulkBodyProblems(draft, kept, "Priya").join(), /Missing number from the draft \(3\)/);
    const done = finishRewrite(draft, draft.replace("Dear Priya,", "Dear Priya,"), signature);
    assert.doesNotMatch(done, /3:04/);
    assert.doesNotMatch(done, /subhan@example\.com/);
    assert.doesNotMatch(done, /to nithin, me/);
    assert.match(done, /to present and explain their work/);
    assert.match(done, /\*\*before Friday\*\*/);
    assert.ok(done.endsWith(signature));
    assert.deepEqual(bulkBodyProblems(draft, done, "Priya"), []);
  });

  it("keeps the weekday, the file name, and the numbered sections", () => {
    const signature = "Subhash Rao\nsubhash@acme-ate.example";
    const draft = `Dear Priya,\n\n1. Review the datasets in notes.rar before Friday.\n\n2. Present the work.\n\n${signature}`;
    const dropped = draft.replace("before Friday", "soon").replace("notes.rar", "the archive");
    const problems = bulkBodyProblems(draft, dropped, "Priya").join();
    assert.match(problems, /Friday/i);
    assert.match(problems, /notes\.rar/);
    assert.match(bulkBodyProblems(draft, draft.replace("2. Present", "Present"), "Priya").join(), /Missing section/);
    const rewritten = "Dear Priya,\n\n1. Please review the datasets before Friday.\n\n2. Present the work.";
    const done = finishRewrite(draft, rewritten, signature);
    assert.match(done, /notes\.rar/);
    assert.match(done, /before Friday/);
    assert.doesNotMatch(done, /\d{1,2}\s+October/);
    assert.ok(done.endsWith(signature));
    assert.deepEqual(bulkBodyProblems(draft, done, "Priya"), []);
  });

  it("notes a weekday deadline and a link, and stays quiet for a calendar date", () => {
    assert.deepEqual(bulkReviewNotes("Please submit before Friday.\n\nhttps://forms.gle/abc"), [
      "Confirm the calendar date for this deadline before sending.",
      "Open each link and confirm the recipient can access it.",
    ]);
    assert.deepEqual(bulkReviewNotes("Please submit before 31 October 2026."), []);
    assert.deepEqual(bulkReviewNotes("Please see Offer.pdf."), ["Confirm the named file is attached before sending."]);
    assert.deepEqual(bulkReviewNotes("Please reply today."), []);
  });

  it("keeps the uploaded body word for word and only adds highlights", () => {
    const upload = "Hi C nithin,\n\n1. Review the datasets\n   - submit the form before Friday\n\nthanks\nsubhan\nsubhan@verilumen.ai";
    const expected = "Hi C nithin,\n\n1. Review the datasets\n   - submit the form **before Friday**\n\nthanks\nsubhan\nsubhan@verilumen.ai";
    const reworded = "Dear Nithin,\n\n1. Please review the datasets.\n- Submit the form **before Friday**.\n\nThanks,\n**subhan**\nsubhan@verilumen.ai";
    assert.equal(applyHighlights(upload, reworded, "subhan\nsubhan@verilumen.ai"), expected);
    assert.equal(applyHighlights(upload, "Hi **Nithin Kumar**, see **all files**"), upload);
    assert.equal(applyHighlights(upload, upload), upload);
    assert.equal(applyHighlights("Send **before Friday** now.", "Send **before Friday** now."), "Send **before Friday** now.");
    assert.equal(defaultHighlight(upload), upload.replace("before Friday", "**before Friday**"));
    assert.equal(defaultHighlight("Send it **today** before Friday."), "Send it **today** before Friday.");
  });

  it("keeps the draft's sentences and rejects a body that drops them", () => {
    const requirement = (n: number) => `This is requirement number ${n} and it must stay available for the candidate to follow.`;
    const draft = `Dear Priya,\n\n${[1, 2, 3, 4].map(requirement).join(" ")}\n\nPlease submit before Friday.`;
    assert.deepEqual(bulkBodyProblems(draft, draft, "Priya"), []);
    const stiff = "Dear Priya,\n\nI am writing to inform you that you have been shortlisted before Friday.";
    assert.deepEqual(bulkBodyProblems(stiff, stiff, "Priya"), []);
    const shortened = `Dear Priya,\n\n${[1, 2].map(requirement).join(" ")}\n\nPlease submit before Friday.`;
    assert.match(bulkBodyProblems(draft, shortened, "Priya").join(), /Removed part of the draft/);
  });

  it("requires the contact name in the opening", () => {
    const team = rendered.replace("Hi Priya Shah,", "Dear Team,");
    assert.match(bulkBodyProblems(rendered, team, "Priya Shah").join(), /recipient by name/);
    assert.deepEqual(bulkBodyProblems(rendered, rendered.replace("Hi Priya Shah,", "Dear Priya,"), "Priya Shah"), []);
  });

  it("detects another recipient leaking into AI output", () => {
    const peers = [
      { id: "a", email: "priya@nova.example", name: "Priya Shah", company: "Nova Semi" },
      { id: "b", email: "liam@orbit.example", name: "Liam Chen", company: "Orbit Devices" },
    ];
    const self = { id: "a", name: "Priya Shah", company: "Nova Semi", renderedBody: rendered };
    assert.deepEqual(bulkLeakProblems({ subject: "Nova Semi SLT", body: rendered }, self, peers), []);
    assert.match(bulkLeakProblems({ subject: "Orbit Devices and Nova Semi", body: rendered }, self, peers).join(), /another recipient/);
  });

  it("allows a peer's email that is already in the sender's body or signature", () => {
    const signed = `${rendered}\n\nBest regards,\nSubhan\n0852 | subhan@verilumen.example`;
    const peers = [
      { id: "a", email: "ganesh@nova.example", name: "Ganesh", company: "Nova Semi" },
      { id: "b", email: "subhan@verilumen.example", name: "Subhan", company: "TechVantage Labs" },
    ];
    const self = { id: "a", name: "Ganesh", company: "Nova Semi", renderedBody: signed };
    assert.deepEqual(bulkLeakProblems({ subject: "Nova Semi SLT", body: signed }, self, peers), []);
    assert.match(bulkLeakProblems({ subject: "Nova Semi SLT", body: `${signed}\nCC liam@orbit.example` }, self, [...peers, { id: "c", email: "liam@orbit.example", name: "Liam", company: "Orbit" }]).join(), /liam@orbit\.example/);
  });

  it("gives the AI the contact's row details and marks missing ones NOT_AVAILABLE", () => {
    const p = buildBulkPrompt({ renderedBody: rendered, fixedSubject: null, aiBody: true, instructions: null, customerName: "Priya Shah", companyName: "Nova Semi", fromName: null, extra: { City: "Pune" } });
    const ctx = extractBulkContext(p.user);
    assert.equal(ctx.to_name, "Priya Shah");
    assert.equal(ctx.company_name, "Nova Semi");
    assert.equal(ctx.from_name, NOT_AVAILABLE);
    assert.equal(ctx.City, "Pune");
    assert.match(p.user, /Return the body exactly as given/);
    assert.match(p.user, /Do not change any word/);
    assert.match(p.system, /Do not correct, rephrase, add, or remove anything/);
    assert.match(p.system, /\*\*double asterisks\*\*/);
    assert.equal(extractBulkField(p.user, "rendered_body"), rendered);
    assert.equal(extractBulkField(p.user, "fixed_subject"), "");
  });
});

describe("outgoing message", () => {
  it("uses the row's from name, then the sender name, as the From display name", () => {
    const account = { email: "me@gmail.example", displayName: "Account Name" };
    const email = { subject: "S", body: "B" };
    assert.deepEqual(composeOutgoing({ account, contact: { email: "priya@nova.example", fromPersonName: "Anita" }, email, senderName: "Subhash Rao" }).from, { email: "me@gmail.example", name: "Anita" });
    assert.equal(composeOutgoing({ account, contact: { email: "x@y.example", fromPersonName: null }, email, senderName: "Subhash Rao" }).from.name, "Subhash Rao");
    assert.equal(composeOutgoing({ account, contact: { email: "x@y.example", fromPersonName: null }, email }).from.name, "Account Name");
  });

  it("copies the CC list on every email, without the To address", () => {
    const msg = composeOutgoing({
      account: { email: "me@gmail.example", displayName: null },
      contact: { email: "priya@nova.example", fromPersonName: null },
      email: { subject: "S", body: "B" },
      cc: ["boss@acme.example", "Priya@Nova.example", "team@acme.example"],
    });
    assert.equal(msg.to, "priya@nova.example");
    assert.deepEqual(msg.cc, ["boss@acme.example", "team@acme.example"]);
    const mime = buildMimeMessage(msg);
    assert.match(mime, /\r\nTo: priya@nova\.example\r\n/);
    assert.match(mime, /\r\nCc: boss@acme\.example, team@acme\.example\r\n/);
    assert.doesNotMatch(buildMimeMessage({ ...msg, cc: [] }), /\r\nCc:/);
    assert.throws(() => buildMimeMessage({ ...msg, cc: ["bad\r\nBcc: x@y.example"] }), /Invalid CC address/);
  });

  it("attaches a file without changing the plain-text body", () => {
    const msg = composeOutgoing({
      account: { email: "me@gmail.example", displayName: null },
      contact: { email: "priya@nova.example", fromPersonName: null },
      email: { subject: "S", body: "Hello Priya" },
      attachments: [{ filename: "brochure.pdf", contentType: "application/pdf", content: Buffer.from("PDFDATA") }],
    });
    const mime = buildMimeMessage(msg);
    assert.match(mime, /Content-Type: multipart\/mixed; boundary="/);
    assert.match(mime, /filename="brochure\.pdf"/);
    assert.match(mime, /Content-Type: application\/pdf/);
    const text = mime.split("Content-Type: text/plain")[1] ?? "";
    const b64 = text.split("\r\n\r\n")[1]?.split("\r\n--")[0]?.replace(/\r\n/g, "") ?? "";
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), "Hello Priya");
    const bare = buildMimeMessage({ ...msg, attachments: [] });
    assert.match(bare, /multipart\/alternative/);
    assert.doesNotMatch(bare, /multipart\/mixed/);
  });

  it("bolds marked phrases in HTML and keeps them plain, with raw markup escaped", () => {
    const source = "Please submit **before Friday**.\n\n<script>alert(1)</script>";
    assert.equal(plainBody(source), "Please submit before Friday.\n\n<script>alert(1)</script>");
    const html = htmlBody(source);
    assert.match(html, /<strong>before Friday<\/strong>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    const designed = htmlBody("Dear Priya,\n\n1. **Dataset**\n- Review the file.\n\nPlease submit **before Friday**.\n\nPriya Shah\npriya@nova.example");
    assert.match(designed, /<li[^>]*>Review the file\./);
    assert.match(designed, />1\. Dataset</);
    assert.doesNotMatch(designed, /width:28px/);
    const lines = htmlBody("Dear Priya,\n\nWhat if your ATE could test faster?\nThe result: lower cost.\n\nBest regards,\nPriya Shah\npriya@nova.example");
    assert.match(lines, /<p[^>]*>What if your ATE could test faster\?<\/p><p[^>]*>The result: lower cost\.<\/p>/);
    assert.match(designed, /<strong>before Friday<\/strong>/);
    const branded = htmlBody("Dear Satish,\n\n1. Dataset\n- Review the file.\n\nVerilumen Labs Pvt. Ltd.\nwww.verilumen.ai");
    assert.match(branded, /src="\/brand\/verilumen-logo.png\?v=navy"/);
    assert.match(branded, /background:#0b1d3a/);
    assert.match(branded, /Verilumen Labs Pvt\. Ltd\./);
    assert.doesNotMatch(branded, /width:28px/);
    const pasted = [
      "subhan <subhan@example.com>",
      "3:04 PM (1 hour ago)",
      "to nithin, me",
      "",
      "Dear Priya,",
      "",
      "to present and explain their work.",
      "",
      "1. Dataset",
      "-> Review the file.",
      "",
      "Best regards,",
      "Priya Shah",
      "priya@nova.example",
      "",
      "<script>alert(1)</script>",
    ].join("\n");
    const laidOut = htmlBody(pasted);
    assert.match(laidOut, /<li[^>]*>Review the file\./);
    assert.doesNotMatch(laidOut, /<p[^>]*>Best regards/);
    assert.match(laidOut, /Best regards/);
    assert.doesNotMatch(laidOut, /3:04/);
    assert.match(laidOut, /to present and explain their work/);
    assert.match(laidOut, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(laidOut, /<script>/);
    assert.doesNotMatch(letterPlain(pasted), /3:04/);
    assert.match(letterPlain(pasted), /to present and explain their work/);
    const msg = composeOutgoing({
      account: { email: "me@gmail.example", displayName: null },
      contact: { email: "priya@nova.example", fromPersonName: null },
      email: { subject: "S", body: source },
    });
    const mime = buildMimeMessage(msg);
    assert.match(mime, /multipart\/alternative/);
    const htmlPart = mime.split("Content-Type: text/html")[1] ?? "";
    const htmlB64 = htmlPart.split("\r\n\r\n")[1]?.split("\r\n--")[0]?.replace(/\r\n/g, "") ?? "";
    const decoded = Buffer.from(htmlB64, "base64").toString("utf8");
    assert.match(decoded, /<strong>before Friday<\/strong>/);
    assert.match(decoded, /&lt;script&gt;/);
    assert.doesNotMatch(decoded, /<script>/);
    const text = mime.split("Content-Type: text/plain")[1] ?? "";
    const b64 = text.split("\r\n\r\n")[1]?.split("\r\n--")[0]?.replace(/\r\n/g, "") ?? "";
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), "Please submit before Friday.\r\n\r\n<script>alert(1)</script>");
    const brandedMsg = composeOutgoing({
      account: { email: "me@gmail.example", displayName: null },
      contact: { email: "satish@nova.example", fromPersonName: null },
      email: { subject: "S", body: "Dear Satish,\n\nPlease review the file.\n\nVerilumen Labs Pvt. Ltd.\nwww.verilumen.ai" },
    });
    const brandedMime = buildMimeMessage(brandedMsg);
    assert.match(brandedMime, /multipart\/related/);
    assert.match(brandedMime, /Content-ID: <verilumen-logo>/);
    assert.match(brandedMime, /image\/png/);
  });
});

describe("campaign attachment", () => {
  it("accepts any file up to 100 MB", () => {
    assert.equal(prepareAttachment("C:\\docs\\Offer.pdf", 1200).contentType, "application/pdf");
    assert.equal(prepareAttachment("notes.txt", 4).filename, "notes.txt");
    assert.equal(prepareAttachment("Test Engineering Solutions.rar", 90 * 1024 * 1024).contentType, "application/vnd.rar");
    assert.equal(prepareAttachment("setup.exe", 20).contentType, "application/octet-stream");
    assert.throws(() => prepareAttachment("empty.pdf", 0), /empty/);
    assert.throws(() => prepareAttachment("big.bin", 101 * 1024 * 1024), /100 MB/);
  });
});

describe("row status", () => {
  const base = { status: "READY", approvalStatus: "PENDING", hasEmail: true, hasDraft: true, blocked: false };
  it("maps database state to one display status", () => {
    assert.equal(bulkRowStatus(base), "READY");
    assert.equal(bulkRowStatus({ ...base, approvalStatus: "APPROVED" }), "APPROVED");
    assert.equal(bulkRowStatus({ ...base, blocked: true }), "INVALID");
    assert.equal(bulkRowStatus({ ...base, hasEmail: false }), "INVALID");
    assert.equal(bulkRowStatus({ ...base, approvalStatus: "REJECTED" }), "REJECTED");
    assert.equal(bulkRowStatus({ ...base, status: "NEW", hasDraft: false }), "DRAFT");
    assert.equal(bulkRowStatus({ ...base, status: "SCHEDULED", approvalStatus: "APPROVED" }), "QUEUED");
    assert.equal(bulkRowStatus({ ...base, status: "SENT", approvalStatus: "APPROVED" }), "SENT");
    assert.equal(bulkRowStatus({ ...base, status: "FAILED", approvalStatus: "APPROVED" }), "FAILED");
  });
});

describe("scheduling in a chosen time zone", () => {
  it("converts wall-clock time in a zone to UTC", () => {
    assert.equal(zonedDateTimeToUtc("2026-10-20", "10:00", "Asia/Kolkata").toISOString(), "2026-10-20T04:30:00.000Z");
    assert.equal(zonedDateTimeToUtc("2026-07-01", "09:00", "America/New_York").toISOString(), "2026-07-01T13:00:00.000Z");
    assert.equal(zonedDateTimeToUtc("2026-12-01", "09:00", "America/New_York").toISOString(), "2026-12-01T14:00:00.000Z");
    assert.equal(zonedDateTimeToUtc("2026-01-15", "23:30", "UTC").toISOString(), "2026-01-15T23:30:00.000Z");
  });

  it("rejects unknown zones and malformed input", () => {
    assert.equal(isValidTimeZone("Europe/Berlin"), true);
    assert.equal(isValidTimeZone("Mars/Base"), false);
    assert.throws(() => zonedDateTimeToUtc("2026-01-01", "10:00", "Mars/Base"), RangeError);
    assert.throws(() => zonedDateTimeToUtc("01/02/2026", "10:00", "UTC"), RangeError);
    assert.throws(() => zonedDateTimeToUtc("2026-01-01", "25:00", "UTC"), RangeError);
  });
});

describe("request schemas", () => {
  it("keeps omitted settings unchanged and clears empty ones", () => {
    const p = bulkSettingsSchema.parse({ subjectTemplate: "" });
    assert.equal(p.aiInstructions, undefined);
    assert.equal(p.ccEmails, undefined);
    assert.equal(p.subjectTemplate, null);
  });

  it("accepts cells and AI instructions with more than 5000 characters", () => {
    const longText = "A".repeat(12000);
    const parsed = bulkCheckSchema.parse({
      headers: ["Company", "Email", "Notes"],
      rows: [{ Company: "Acme", Email: "test@example.com", Notes: longText }],
    });
    assert.equal(parsed.rows[0].Notes.length, 12000);

    const s = bulkSettingsSchema.parse({ aiInstructions: "B".repeat(6000) });
    assert.equal(s.aiInstructions?.length, 6000);
  });

  it("normalises the CC list and rejects bad addresses", () => {
    assert.deepEqual(ccEmailsSchema.parse([" Boss@Acme.example ", "boss@acme.example", "team@acme.example"]), ["boss@acme.example", "team@acme.example"]);
    assert.throws(() => ccEmailsSchema.parse(["not-an-email"]));
    assert.throws(() => ccEmailsSchema.parse(Array.from({ length: 11 }, (_, i) => `u${i}@acme.example`)));
  });

  it("validates the final send request and a corrected address", () => {
    const s = bulkSendSchema.parse({ confirmText: "APPROVE & SEND ALL" });
    assert.equal(s.startMode, "now");
    assert.equal(s.intervalSeconds, 30);
    assert.throws(() => bulkSendSchema.parse({ confirmText: "x", intervalSeconds: 0 }));
    assert.deepEqual(recipientEmailSchema.parse({ email: " Sales@Nova.Example " }), { email: "sales@nova.example" });
  });

  it("orders the seven wizard steps", () => {
    assert.deepEqual(
      BULK_STEPS.map((s) => s.slug),
      ["contacts", "template", "sender", "generate", "review", "send", "results"],
    );
    assert.equal(isBulkStep("review"), true);
    assert.equal(isBulkStep("research"), false);
    assert.equal(nextBulkStep("template"), "sender");
    assert.equal(nextBulkStep("sender"), "generate");
    assert.equal(nextBulkStep("results"), null);
  });
});
