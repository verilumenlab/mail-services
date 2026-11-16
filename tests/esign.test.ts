import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, degrees } from "pdf-lib";
import { auditHash, verifyAuditChain, type AuditEntry, type StoredAuditRow } from "@/lib/esign/audit-chain";
import { buildCertificate } from "@/lib/esign/certificate";
import { cancelledEmail, escapeHtml, invitationEmail, type RequestContext } from "@/lib/esign/email-template";
import { pdfNameFor, safeFileName, sha256Hex, sniffUpload } from "@/lib/esign/files";
import { clampRect, displayPointToPdf, fitContain, placementFor, type PageBox } from "@/lib/esign/geometry";
import { canSendOtp, checkOtpAttempt, generateOtp, hashOtp, maskEmail, maskPhone, otpMatches, OTP_MAX_ATTEMPTS } from "@/lib/esign/otp";
import { appendPdf, stampFields, winAnsiSafe } from "@/lib/esign/pdf";
import { activeSigners, advanceSigner, deriveRequestStatus, isTurnOf, type RoutedRecipient } from "@/lib/esign/status";
import { hashLinkToken, hashesEqual, isLinkTokenShape, linkState, newLinkToken, signingLink } from "@/lib/esign/tokens";
import { requestDraftSchema, signSchema } from "@/lib/validation/esign";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function hexOf(text: string): string {
  return Buffer.from(text, "latin1").toString("hex").toUpperCase();
}

/** Every decoded content stream of the document, joined; enough to find drawn text and image operators. */
function contentOf(doc: PDFDocument): string {
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype"))) continue;
    try {
      out += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1") + "\n";
    } catch {
      // Not a decodable content stream.
    }
  }
  return out;
}

describe("signing links", () => {
  it("issues 43-character random tokens and stores only their hash", () => {
    const a = newLinkToken();
    const b = newLinkToken();
    assert.notEqual(a, b);
    assert.ok(isLinkTokenShape(a));
    assert.equal(hashLinkToken(a).length, 64);
    assert.notEqual(hashLinkToken(a), a);
    assert.ok(hashesEqual(hashLinkToken(a), hashLinkToken(a)));
    assert.ok(!hashesEqual(hashLinkToken(a), hashLinkToken(b)));
    assert.ok(!hashesEqual("", ""));
  });

  it("rejects malformed tokens and builds links without double slashes", () => {
    assert.ok(!isLinkTokenShape("short"));
    assert.ok(!isLinkTokenShape("a".repeat(42) + "/"));
    assert.equal(signingLink("https://app.example.com/", "tok"), "https://app.example.com/sign/tok");
  });

  it("stops working once revoked or expired", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    assert.equal(linkState({ revokedAt: null, expiresAt: new Date("2026-11-12T00:00:00Z"), now }), "OK");
    assert.equal(linkState({ revokedAt: now, expiresAt: new Date("2026-11-12T00:00:00Z"), now }), "REVOKED");
    assert.equal(linkState({ revokedAt: null, expiresAt: now, now }), "EXPIRED");
  });
});

describe("one-time codes", () => {
  const secret = Buffer.from("test-secret");

  it("generates 6-digit codes bound to recipient and channel", () => {
    const code = generateOtp();
    assert.match(code, /^\d{6}$/);
    const stored = hashOtp(secret, "r1", "EMAIL", code);
    assert.ok(otpMatches(secret, "r1", "EMAIL", code, stored));
    assert.ok(!otpMatches(secret, "r2", "EMAIL", code, stored), "another recipient");
    assert.ok(!otpMatches(secret, "r1", "SMS", code, stored), "another channel");
    assert.ok(!otpMatches(secret, "r1", "EMAIL", "12345", stored), "wrong shape");
  });

  it("expires, counts attempts and locks", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    const later = new Date(now.getTime() + 60_000);
    assert.equal(checkOtpAttempt({ matches: true, attempts: 1, expiresAt: later, now }), "OK");
    assert.equal(checkOtpAttempt({ matches: false, attempts: 1, expiresAt: later, now }), "WRONG");
    assert.equal(checkOtpAttempt({ matches: false, attempts: OTP_MAX_ATTEMPTS, expiresAt: later, now }), "LOCKED");
    assert.equal(checkOtpAttempt({ matches: true, attempts: OTP_MAX_ATTEMPTS + 1, expiresAt: later, now }), "LOCKED");
    assert.equal(checkOtpAttempt({ matches: true, attempts: 1, expiresAt: new Date(now.getTime() - 1), now }), "EXPIRED");
  });

  it("limits how often codes are sent", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    const recent = (mins: number[]) => mins.map((m) => new Date(now.getTime() - m * 60_000));
    assert.ok(canSendOtp(recent([1, 2]), now));
    assert.ok(!canSendOtp(recent([1, 2, 3]), now));
    assert.ok(canSendOtp(recent([1, 2, 30]), now), "old sends fall out of the window");
  });

  it("masks destinations", () => {
    assert.equal(maskEmail("jane@acme.io"), "ja**@acme.io");
    assert.equal(maskPhone("+919876543210"), "********3210");
  });
});

describe("field geometry", () => {
  const portrait: PageBox = { x: 0, y: 0, width: 600, height: 800, rotation: 0 };

  it("keeps fields on the page and above the minimum size", () => {
    assert.deepEqual(clampRect({ x: 0.95, y: -0.2, width: 0.2, height: 0.001 }), { x: 0.8, y: 0, width: 0.2, height: 0.01 });
  });

  it("maps a top-left normalised rectangle to a bottom-left PDF placement", () => {
    const p = placementFor(portrait, { x: 0.1, y: 0.1, width: 0.25, height: 0.05 });
    assert.equal(p.x, 60);
    assert.equal(p.y, 800 - 0.15 * 800);
    assert.equal(p.width, 150);
    assert.equal(p.height, 40);
    assert.equal(p.rotate, 0);
  });

  it("handles rotated pages and offset crop boxes", () => {
    const rotated: PageBox = { x: 0, y: 0, width: 600, height: 800, rotation: 90 };
    assert.deepEqual(displayPointToPdf(rotated, 0, 300), { x: 300, y: 0 });
    const p = placementFor(rotated, { x: 0, y: 0, width: 0.5, height: 0.5 });
    assert.deepEqual(p, { x: 300, y: 0, width: 400, height: 300, rotate: 90 });
    const cropped: PageBox = { x: 20, y: 30, width: 500, height: 700, rotation: 0 };
    assert.deepEqual(displayPointToPdf(cropped, 0, 0), { x: 20, y: 730 });
    assert.deepEqual(displayPointToPdf({ ...portrait, rotation: 180 }, 0, 0), { x: 600, y: 0 });
    assert.deepEqual(displayPointToPdf({ ...portrait, rotation: 270 }, 0, 0), { x: 600, y: 800 });
  });

  it("fits signature images without distortion", () => {
    assert.deepEqual(fitContain(200, 50, 400, 200), { width: 100, height: 50, offsetX: 50, offsetY: 0 });
  });
});

describe("routing and status", () => {
  const r = (id: string, routingOrder: number, status: RoutedRecipient["status"], role: RoutedRecipient["role"] = "SIGNER"): RoutedRecipient => ({ id, role, routingOrder, status });

  it("sequential signing offers the lowest unsigned order only", () => {
    const people = [r("a", 1, "SIGNED"), r("b", 2, "DELIVERED"), r("c", 2, "WAITING"), r("d", 3, "WAITING"), r("cc", 1, "WAITING", "CC")];
    assert.deepEqual(activeSigners("SEQUENTIAL", people).map((x) => x.id), ["b", "c"]);
    assert.ok(isTurnOf("SEQUENTIAL", people, "c"));
    assert.ok(!isTurnOf("SEQUENTIAL", people, "d"));
    assert.ok(!isTurnOf("SEQUENTIAL", people, "cc"), "CC never signs");
  });

  it("parallel signing offers everyone who has not signed", () => {
    const people = [r("a", 1, "SIGNED"), r("b", 2, "DELIVERED"), r("c", 3, "WAITING")];
    assert.deepEqual(activeSigners("PARALLEL", people).map((x) => x.id), ["b", "c"]);
  });

  it("nobody can sign after a rejection", () => {
    assert.deepEqual(activeSigners("PARALLEL", [r("a", 1, "REJECTED"), r("b", 1, "SENT")]), []);
  });

  it("derives the request status from signers", () => {
    assert.equal(deriveRequestStatus("SENT", [r("a", 1, "DELIVERED"), r("b", 2, "WAITING")]), "DELIVERED");
    assert.equal(deriveRequestStatus("SENT", [r("a", 1, "VIEWED"), r("b", 2, "WAITING")]), "VIEWED");
    assert.equal(deriveRequestStatus("VIEWED", [r("a", 1, "SIGNED"), r("b", 2, "WAITING")]), "PARTIALLY_SIGNED");
    assert.equal(deriveRequestStatus("PARTIALLY_SIGNED", [r("a", 1, "SIGNED"), r("b", 2, "SIGNED"), r("c", 1, "WAITING", "CC")]), "PENDING");
    assert.equal(deriveRequestStatus("VIEWED", [r("a", 1, "REJECTED"), r("b", 2, "WAITING")]), "REJECTED");
    assert.equal(deriveRequestStatus("COMPLETED", [r("a", 1, "VIEWED")]), "COMPLETED", "final statuses stick");
    assert.equal(deriveRequestStatus("DRAFT", [r("a", 1, "SIGNED")]), "DRAFT");
  });

  it("signer progress never moves backwards", () => {
    assert.equal(advanceSigner("VIEWED", "DELIVERED"), "VIEWED");
    assert.equal(advanceSigner("DELIVERED", "VIEWED"), "VIEWED");
    assert.equal(advanceSigner("SIGNED", "REJECTED"), "SIGNED");
  });
});

describe("audit hash chain", () => {
  function chain(n: number): StoredAuditRow[] {
    const rows: StoredAuditRow[] = [];
    let prev: string | null = null;
    for (let i = 0; i < n; i++) {
      const entry: AuditEntry = {
        action: `ACTION_${i}`,
        actor: i % 2 ? "signer:jane@acme.io" : "system",
        userId: "u1",
        requestId: "req1",
        documentId: null,
        recipientId: i % 2 ? "r1" : null,
        ip: "203.0.113.7",
        userAgent: "test",
        details: { step: i, nested: { b: 1, a: 2 } },
        createdAt: new Date(Date.UTC(2026, 10, 11, 10, i)).toISOString(),
      };
      const hash = auditHash(prev, entry);
      rows.push({ ...entry, id: `row${i}`, prevHash: prev, hash });
      prev = hash;
    }
    return rows;
  }

  it("verifies an untouched chain", () => {
    assert.deepEqual(verifyAuditChain(chain(5)), { ok: true });
  });

  it("is independent of key order in details", () => {
    const rows = chain(2);
    rows[1] = { ...rows[1], details: { nested: { a: 2, b: 1 }, step: 1 } };
    assert.deepEqual(verifyAuditChain(rows), { ok: true });
  });

  it("detects an edited entry", () => {
    const rows = chain(5);
    rows[2] = { ...rows[2], ip: "198.51.100.1" };
    const res = verifyAuditChain(rows);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.brokenAt, "row2");
  });

  it("detects a removed entry", () => {
    const rows = chain(5);
    rows.splice(2, 1);
    const res = verifyAuditChain(rows);
    assert.equal(!res.ok && res.brokenAt, "row3");
  });
});

describe("uploads", () => {
  it("decides the file type from content, not the name", async () => {
    const pdf = await (await PDFDocument.create()).save();
    assert.equal(sniffUpload(new Uint8Array(pdf)), "pdf");
    assert.equal(sniffUpload(new TextEncoder().encode("hello, not a pdf")), null);
    assert.equal(sniffUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), null, "a broken zip is not a docx");
  });

  it("hashes with SHA-256 and sanitises file names", () => {
    assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(safeFileName("..\\..\\evil<name>.pdf"), "evil_name_.pdf");
    assert.equal(pdfNameFor("Contract v2.docx"), "Contract v2.pdf");
  });
});

describe("validation", () => {
  const base = {
    documentVersionId: "v1",
    title: "NDA",
    signingOrder: "SEQUENTIAL" as const,
    expiresInDays: 14,
    reminderEveryDays: 2,
    recipients: [{ name: "Jane", email: "Jane@Acme.io", role: "SIGNER" as const, routingOrder: 1 }],
  };

  it("accepts a normal request and lower-cases emails", () => {
    const parsed = requestDraftSchema.parse(base);
    assert.equal(parsed.recipients[0].email, "jane@acme.io");
  });

  it("rejects duplicate recipients, CC-only requests and SMS without a phone", () => {
    assert.ok(!requestDraftSchema.safeParse({ ...base, recipients: [...base.recipients, { ...base.recipients[0], email: "jane@acme.io" }] }).success);
    assert.ok(!requestDraftSchema.safeParse({ ...base, recipients: [{ ...base.recipients[0], role: "CC" }] }).success);
    assert.ok(!requestDraftSchema.safeParse({ ...base, recipients: [{ ...base.recipients[0], requireSmsOtp: true }] }).success);
  });

  it("requires explicit intent and a PNG signature", () => {
    const sig = { signature: { method: "DRAWN", image: `data:image/png;base64,${PNG_1X1.toString("base64")}` }, documentSha256: "a".repeat(64) };
    assert.ok(signSchema.safeParse({ ...sig, agree: true }).success);
    assert.ok(!signSchema.safeParse({ ...sig, agree: false }).success);
    assert.ok(!signSchema.safeParse({ ...sig, agree: true, signature: { method: "DRAWN", image: "data:image/svg+xml;base64,PHN2Zz4=" } }).success);
  });
});

describe("emails", () => {
  const ctx: RequestContext = {
    appUrl: "https://app.example.com",
    title: "NDA <script>",
    documentTitle: "Mutual NDA",
    senderName: "Sam",
    senderEmail: "sam@example.com",
    senderCompany: null,
    message: "Please sign by Friday",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  };

  it("escapes HTML and includes the Review Document button", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    const mail = invitationEmail(ctx, { name: "Jane", role: "SIGNER" }, "https://app.example.com/sign/TOKEN");
    assert.ok(mail.html.includes("Review Document"));
    assert.ok(mail.html.includes("https://app.example.com/sign/TOKEN"));
    assert.ok(!mail.html.includes("<script>"), "untrusted text is escaped");
    assert.ok(mail.text.includes("https://app.example.com/sign/TOKEN"));
  });

  it("never puts a signing link in cancellation emails", () => {
    const mail = cancelledEmail(ctx, { name: "Jane" }, "Wrong version");
    assert.ok(!mail.html.includes("/sign/"));
    assert.ok(mail.text.includes("Wrong version"));
  });
});

describe("PDF stamping and certificate", () => {
  async function samplePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const rotated = doc.addPage([600, 800]);
    rotated.setRotation(degrees(90));
    return doc.save();
  }

  it("draws signatures and values without changing the original pages", async () => {
    const original = await samplePdf();
    const stamped = await stampFields(
      original,
      [
        { id: "f1", recipientId: "r1", type: "SIGNATURE", page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.08, value: null },
        { id: "f2", recipientId: "r1", type: "NAME", page: 1, x: 0.5, y: 0.8, width: 0.4, height: 0.04, value: "Jane Doe" },
        { id: "f3", recipientId: "r1", type: "DATE", page: 2, x: 0.1, y: 0.1, width: 0.3, height: 0.04, value: "11 Nov 2026" },
      ],
      new Map([["r1", new Uint8Array(PNG_1X1)]]),
    );
    assert.notEqual(sha256Hex(stamped), sha256Hex(original));
    const doc = await PDFDocument.load(stamped);
    assert.equal(doc.getPageCount(), 2);
    assert.equal(doc.getPage(1).getRotation().angle, 90);
    assert.deepEqual(doc.getPage(0).getSize(), { width: 600, height: 800 });
    const content = contentOf(doc);
    assert.ok(content.includes(hexOf("Jane Doe")) || content.includes("(Jane Doe)"), "name text drawn");
    assert.ok(content.includes(hexOf("11 Nov 2026")) || content.includes("(11 Nov 2026)"), "date drawn on the rotated page");
    assert.match(content, /\/[\w-]+ Do/, "signature image drawn");
  });

  it("replaces characters the standard fonts cannot draw", () => {
    assert.equal(winAnsiSafe("“Zoë” – ok"), '"Zoë" - ok');
    assert.equal(winAnsiSafe("सुब"), "???");
  });

  it("appends a completion certificate after the signed pages", async () => {
    const cert = await buildCertificate({
      requestId: "req1",
      title: "NDA",
      documentTitle: "Mutual NDA",
      documentVersion: 1,
      pageCount: 2,
      sender: { name: "Sam", email: "sam@example.com", company: "Acme" },
      signingOrder: "SEQUENTIAL",
      createdAt: new Date("2026-11-10T10:00:00Z"),
      sentAt: new Date("2026-11-10T10:05:00Z"),
      completedAt: new Date("2026-11-11T10:00:00Z"),
      originalSha256: "a".repeat(64),
      signedSha256: "b".repeat(64),
      signatureLevel: "electronic",
      consentText: "I agree to sign electronically.",
      auditIntact: true,
      signers: [
        {
          name: "Jane Doe",
          email: "jane@acme.io",
          role: "SIGNER",
          routingOrder: 1,
          status: "SIGNED",
          method: "DRAWN",
          typedName: null,
          ip: "203.0.113.7",
          userAgent: "Mozilla/5.0",
          sentAt: new Date("2026-11-10T10:05:00Z"),
          viewedAt: new Date("2026-11-10T11:00:00Z"),
          reviewedAt: new Date("2026-11-10T11:02:00Z"),
          consentAt: new Date("2026-11-10T11:03:00Z"),
          consentIp: "203.0.113.7",
          emailVerifiedAt: new Date("2026-11-10T11:04:00Z"),
          smsVerifiedAt: null,
          signedAt: new Date("2026-11-10T11:05:00Z"),
          signatureImage: new Uint8Array(PNG_1X1),
        },
      ],
      events: Array.from({ length: 60 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 10, 10, i)), type: "EVENT", message: `Event number ${i} with a reasonably long description to wrap`, ip: null })),
    });
    const certDoc = await PDFDocument.load(cert);
    assert.ok(certDoc.getPageCount() >= 2, "long timelines continue on new pages");
    const final = await appendPdf(await samplePdf(), cert);
    assert.equal((await PDFDocument.load(final)).getPageCount(), 2 + certDoc.getPageCount());
  });
});
