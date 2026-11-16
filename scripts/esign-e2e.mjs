// End-to-end check of the E-Signature module against a running dev server, using the mock email provider.
// The dev server must run with ESIGN_DEV_OUTBOX set (same value as here) so signing links and one-time codes
// can be read from the mails it "sends". Nothing is delivered to real inboxes.
//
// Usage: ESIGN_DEV_OUTBOX=<dir> node scripts/esign-e2e.mjs [baseUrl]
// Optional: DATABASE_URL to also prove the audit tables reject UPDATE/DELETE.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const OUTBOX = process.env.ESIGN_DEV_OUTBOX || path.join(os.tmpdir(), "esign-outbox");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 600)}` : ""}`);
  }
}
function note(text) {
  console.log(`  NOTE  ${text}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function client() {
  const jar = new Map();
  function headersFor(m, extra = {}, origin = BASE) {
    const headers = { Origin: origin, ...extra };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (m !== "GET" && jar.has("ecm_csrf")) headers["X-CSRF-Token"] = decodeURIComponent(jar.get("ecm_csrf"));
    return headers;
  }
  function keep(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (expired) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  async function call(p, { method, body, origin } = {}) {
    const m = method ?? (body === undefined ? "GET" : "POST");
    const headers = headersFor(m, body !== undefined ? { "Content-Type": "application/json" } : {}, origin);
    const res = await fetch(BASE + p, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    keep(res);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/pdf")) return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }
  async function upload(p, fileName, bytes, type, title = "") {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type }), fileName);
    form.set("title", title);
    const res = await fetch(BASE + p, { method: "POST", headers: headersFor("POST"), body: form });
    keep(res);
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  return { call, upload, jar };
}

async function waitFor(fn, label, timeoutMs = 60_000, everyMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Mails written by the server's dev outbox since `since`, newest last. */
async function mails(since) {
  let names = [];
  try {
    names = await readdir(OUTBOX);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const file = path.join(OUTBOX, name);
    const s = await stat(file);
    if (s.mtimeMs < since) continue;
    out.push({ at: s.mtimeMs, name, ...JSON.parse(await readFile(file, "utf8")) });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}
async function waitMail(to, kind, since, timeoutMs = 30_000) {
  return waitFor(async () => (await mails(since)).filter((m) => m.to === to && m.kind === kind).pop(), `${kind} mail to ${to}`, timeoutMs);
}
const linkIn = (mail) => mail.text.match(/\/sign\/([A-Za-z0-9_-]{43})/)?.[1];
const codeIn = (mail) => mail.text.match(/\b(\d{6})\b/)?.[1];

async function ndaPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("MUTUAL NON-DISCLOSURE AGREEMENT", { x: 60, y: 770, size: 16, font: bold });
  const clauses = [
    "1. Each party may disclose confidential information to the other for the purpose of evaluating a business relationship.",
    "2. The receiving party shall keep the information confidential and use it only for that purpose.",
    "3. This agreement lasts two years from the date of the last signature.",
  ];
  clauses.forEach((c, i) => p1.drawText(c, { x: 60, y: 720 - i * 24, size: 9, font, color: rgb(0.1, 0.1, 0.1) }));
  p1.drawText("Initials: ______", { x: 440, y: 60, size: 10, font });
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("SIGNATURES", { x: 60, y: 770, size: 14, font: bold });
  p2.drawText("Disclosing party", { x: 60, y: 600, size: 10, font });
  p2.drawText("Receiving party", { x: 320, y: 600, size: 10, font });
  return doc.save();
}

function minimalDocx() {
  const xml = (s) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`);
  return zipSync({
    "[Content_Types].xml": xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Short NDA (Word)</w:t></w:r></w:p></w:body></w:document>'),
  });
}

async function signaturePng(text) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="140"><path d="M20 100 C 80 20, 140 140, 200 60 S 320 120, 460 40" stroke="#0b1d4d" stroke-width="5" fill="none"/><text x="30" y="130" font-size="22" fill="#0b1d4d">${text}</text></svg>`;
  return `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64")}`;
}

/** Walks one recipient through review, consent, email code and signing, the same calls the signing page makes. */
async function signAs(name, token, since, opts = {}) {
  const s = client();
  const base = `/api/signature-requests/${token}`;
  let r = await s.call(`${base}/review`);
  check(`${name}: link opens the request`, r.status === 200 && !r.data.problem && r.data.me.status === "VIEWED", r.data);
  check(`${name}: review response is not cached`, (r.headers.get("cache-control") ?? "").includes("no-store"));
  const view = r.data;
  const doc = await s.call(`${base}/document`);
  check(`${name}: document matches the hash fixed at sending`, doc.status === 200 && sha256(doc.bytes) === view.request.documentSha256, doc.status);
  r = await s.call(`${base}/consent`, { body: { agree: true } });
  check(`${name}: consent before reviewing every page is refused`, r.status >= 400, r.status);
  r = await s.call(`${base}/review`, { body: { pagesSeen: 1 } });
  check(`${name}: partial review is refused`, r.status === 400, r.data);
  r = await s.call(`${base}/review`, { body: { pagesSeen: view.request.pageCount } });
  check(`${name}: review recorded`, r.status === 200, r.data);
  r = await s.call(`${base}/verify`, { body: { channel: "EMAIL" } });
  check(`${name}: code cannot be requested before consent`, r.status >= 400, r.status);
  r = await s.call(`${base}/consent`, { body: { agree: true } });
  check(`${name}: consent recorded`, r.status === 200, r.data);
  const sentAt = Date.now() - 1000;
  r = await s.call(`${base}/verify`, { body: { channel: "EMAIL" } });
  check(`${name}: one-time code sent to masked address`, r.status === 200 && r.data.destination?.includes("*"), r.data);
  const otpMail = await waitMail(view.me.email, "OTP", sentAt);
  const code = codeIn(otpMail);
  check(`${name}: code arrives by email`, /^\d{6}$/.test(code ?? ""), otpMail.text);
  const signature = { method: "DRAWN", image: await signaturePng(name) };
  const values = Object.fromEntries(view.fields.filter((f) => f.type === "TEXT").map((f) => [f.id, opts.text ?? "Director"]));
  r = await s.call(`${base}/sign`, { body: { signature, values, documentSha256: view.request.documentSha256, agree: true } });
  check(`${name}: signing without a verified code is refused`, r.status >= 400, r.data);
  if (opts.wrongCode) {
    const wrong = code === "000000" ? "111111" : "000000";
    r = await s.call(`${base}/verify`, { body: { channel: "EMAIL", code: wrong } });
    check(`${name}: wrong code rejected`, r.status >= 400 && r.status < 500, r.data);
  }
  r = await s.call(`${base}/verify`, { body: { channel: "EMAIL", code } });
  check(`${name}: code verified and signing session cookie set`, r.status === 200 && r.data.sessionActive === true && [...s.jar.keys()].some((k) => k.startsWith("esign_s_")), r.data);
  r = await s.call(`${base}/sign`, { body: { signature, values, documentSha256: "0".repeat(64), agree: true } });
  check(`${name}: signing a different document hash is refused`, r.status === 409 || r.status === 400, r.data);
  if (opts.withInitials) signature.initialsImage = await signaturePng(name.slice(0, 2).toUpperCase());
  r = await s.call(`${base}/sign`, { body: { signature, values, documentSha256: view.request.documentSha256, agree: true } });
  check(`${name}: signed`, r.status === 200, r.data);
  r = await s.call(`${base}/sign`, { body: { signature, values, documentSha256: view.request.documentSha256, agree: true } });
  check(`${name}: signing twice is refused`, r.status >= 400, r.data);
  return { client: s, view };
}

async function newRequest(a, versionId, body) {
  const r = await a.call("/api/signature-requests", {
    body: { documentVersionId: versionId, signingOrder: "PARALLEL", expiresInDays: 7, reminderEveryDays: 2, ...body },
  });
  if (r.status !== 201) throw new Error(`create request failed: ${JSON.stringify(r.data)}`);
  const id = r.data.request.id;
  const got = await a.call(`/api/signature-requests/${id}`);
  return { id, recipients: got.data.request.recipients };
}

async function signatureFieldsFor(a, id, recipients) {
  const fields = recipients
    .filter((x) => x.role !== "CC")
    .map((x, i) => ({ recipientId: x.id, type: "SIGNATURE", page: 2, x: 0.1 + i * 0.45, y: 0.3, width: 0.3, height: 0.07, required: true }));
  return a.call("/api/signature-fields", { method: "PUT", body: { requestId: id, fields } });
}

async function main() {
  const stamp = Date.now();
  if (process.env.DATABASE_URL) {
    // Every run comes from one IP; start with fresh per-IP signer limits so repeated runs do not trip them.
    const { default: pg } = await import("pg");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query("DELETE FROM rate_limit_buckets WHERE key LIKE 'signer-%' OR key LIKE 'esign-%'");
    await db.end();
  }
  const a = client();
  const b = client();

  console.log("1. Sender setup (mock email, nothing is delivered)");
  let r = await a.call("/api/auth/register", { body: { name: "Esign Sender", email: `esign${stamp}@example.com`, password: "correct-horse-battery" } });
  check("sender registers", r.status === 200, r.data);
  r = await b.call("/api/auth/register", { body: { name: "Other", email: `esign-other${stamp}@example.com`, password: "correct-horse-battery" } });
  check("second user registers", r.status === 200, r.data);
  r = await a.call("/api/settings/providers", { method: "PUT", body: { ai: "mock", email: "mock" } });
  check("mock email provider selected", r.status === 200 && r.data.email === "mock", r.data);
  r = await a.call("/api/email-account/mock", { body: {} });
  check("mock mailbox connected", r.status === 200, r.data);

  console.log("2. Documents");
  r = await a.upload("/api/documents", "notes.pdf", new TextEncoder().encode("not really a pdf"), "application/pdf");
  check("a file that only claims to be PDF is rejected", r.status === 400, r.data);
  r = await a.upload("/api/documents", "short-nda.docx", minimalDocx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Short NDA");
  if (r.status === 201) check("DOCX converted to PDF", r.data.document.latest.converted === true && r.data.document.latest.pageCount >= 1, r.data);
  else {
    check("DOCX without LibreOffice gives a clear configuration error", r.status === 503 && /LibreOffice/i.test(r.data?.error?.message ?? ""), r);
    note("LibreOffice is not installed here, so DOCX conversion was not exercised.");
  }
  const nda = await ndaPdf();
  r = await a.upload("/api/documents", "Mutual NDA.pdf", nda, "application/pdf", "Mutual NDA");
  check("NDA PDF uploaded", r.status === 201 && r.data.document.latest.pageCount === 2, r.data);
  const docId = r.data.document.id;
  const version = r.data.document.latest;
  check("stored hash matches the uploaded bytes", version.pdfSha256 === sha256(nda), version);
  check("upload response exposes no storage keys", !/Key|storage|\.bin/.test(JSON.stringify(r.data)), r.data);
  r = await a.call(`/api/documents/${docId}/file?version=${version.id}`);
  check("owner can read the PDF back unchanged", r.status === 200 && sha256(r.bytes) === version.pdfSha256, r.status);
  r = await b.call(`/api/documents/${docId}`);
  check("another user cannot see the document (404)", r.status === 404, r.status);
  r = await b.call(`/api/documents/${docId}/file?version=${version.id}`);
  check("another user cannot download the file (404)", r.status === 404, r.status);
  r = await client().call(`/api/documents/${docId}/file?version=${version.id}`);
  check("anonymous download blocked (401)", r.status === 401, r.status);

  console.log("3. Signing request: sequential, two signers + CC");
  const priya = `priya.${stamp}@helix.example`;
  const tom = `tom.${stamp}@orion.example`;
  const legal = `legal.${stamp}@vertex.example`;
  r = await a.call("/api/signature-requests", {
    body: {
      documentVersionId: version.id,
      title: "Mutual NDA - Helix x Orion",
      message: "Please review and sign by Friday.",
      signingOrder: "SEQUENTIAL",
      expiresInDays: 14,
      reminderEveryDays: 2,
      senderCompany: "Vertex Labs",
      recipients: [
        { name: "Priya Shah", email: priya, role: "SIGNER", routingOrder: 1 },
        { name: "Tom Becker", email: tom, role: "SIGNER", routingOrder: 2 },
        { name: "Legal Team", email: legal, role: "CC", routingOrder: 3 },
      ],
    },
  });
  check("draft created", r.status === 201, r.data);
  const reqId = r.data.request.id;
  r = await a.call(`/api/signature-requests/${reqId}`);
  const recips = r.data.request.recipients;
  const rid = (email) => recips.find((x) => x.email === email).id;
  check("draft lists what is missing before sending", r.data.problems.length > 0, r.data.problems);
  r = await a.call(`/api/signature-requests/${reqId}/send`, { body: { confirm: true } });
  check("sending without signature fields is refused", r.status === 400, r.data);
  r = await a.call("/api/signature-fields", {
    method: "PUT",
    body: {
      requestId: reqId,
      fields: [
        { recipientId: rid(priya), type: "INITIALS", page: 1, x: 0.82, y: 0.9, width: 0.1, height: 0.04, required: true },
        { recipientId: rid(priya), type: "SIGNATURE", page: 2, x: 0.1, y: 0.3, width: 0.32, height: 0.07, required: true },
        { recipientId: rid(priya), type: "NAME", page: 2, x: 0.1, y: 0.38, width: 0.32, height: 0.03, required: true },
        { recipientId: rid(priya), type: "DATE", page: 2, x: 0.1, y: 0.42, width: 0.2, height: 0.03, required: true },
        { recipientId: rid(tom), type: "SIGNATURE", page: 2, x: 0.55, y: 0.3, width: 0.32, height: 0.07, required: true },
        { recipientId: rid(tom), type: "TEXT", page: 2, x: 0.55, y: 0.38, width: 0.32, height: 0.03, required: true, label: "Job title" },
        { recipientId: rid(tom), type: "DATE", page: 2, x: 0.55, y: 0.42, width: 0.2, height: 0.03, required: true },
      ],
    },
  });
  check("fields saved", r.status === 200, r.data);
  r = await a.call("/api/signature-fields", {
    method: "PUT",
    body: { requestId: reqId, fields: [{ recipientId: rid(legal), type: "SIGNATURE", page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05, required: true }] },
  });
  check("a CC recipient cannot be given a signature field", r.status === 400, r.data);
  r = await b.call(`/api/signature-requests/${reqId}`);
  check("another user cannot read the request (404)", r.status === 404, r.status);
  r = await b.call(`/api/signature-requests/${reqId}/send`, { body: { confirm: true } });
  check("another user cannot send it (404)", r.status === 404, r.status);

  const sentSince = Date.now() - 1000;
  r = await a.call(`/api/signature-requests/${reqId}/send`, { body: { confirm: true } });
  check("request sent", r.status === 200, r.data);
  r = await a.call(`/api/signature-requests/${reqId}/send`, { body: { confirm: true } });
  check("sending twice is refused", r.status === 409 || r.status === 400, r.data);
  const invite1 = await waitMail(priya, "INVITATION", sentSince);
  const token1 = linkIn(invite1);
  check("first signer gets a personal Review Document link", Boolean(token1) && invite1.text.includes("Review Document"), invite1.text);
  await sleep(1000);
  check("second signer is not emailed before the first signs", !(await mails(sentSince)).some((m) => m.to === tom), (await mails(sentSince)).map((m) => `${m.kind}:${m.to}`));
  r = await a.call(`/api/signature-requests/${reqId}`);
  check("request shows Delivered after the provider accepted the mail", r.data.request.status === "DELIVERED", r.data.request.status);

  console.log("4. Recipient link security");
  r = await client().call(`/api/signature-requests/${"x".repeat(43)}/review`);
  check("an unknown token is rejected (404)", r.status === 404, r.status);
  r = await client().call(`/api/signature-requests/${token1}`);
  check("the sender API does not accept a signing token (401)", r.status === 401, r.status);
  r = await client().call(`/api/signature-requests/${token1}/review`);
  check("signer view exposes no storage keys or tokens", r.status === 200 && !/Key"|tokenHash|tokenEnc|storage|\.bin/.test(JSON.stringify(r.data)), r.data);
  check("signer view hides other recipients' emails", !JSON.stringify(r.data).includes(tom) && !JSON.stringify(r.data).includes(legal), r.data);
  const page = await fetch(`${BASE}/sign/${token1}`, { redirect: "manual" });
  check("signing page loads without login", page.status === 200, page.status);
  check("signing page is noindex and sends no referrer", /noindex/.test(page.headers.get("x-robots-tag") ?? "") && page.headers.get("referrer-policy") === "no-referrer", Object.fromEntries(page.headers));
  r = await client().call(`/api/signature-requests/${token1}/review`, { body: { pagesSeen: 2 }, origin: "https://evil.example" });
  check("signer actions from another site are refused (403)", r.status === 403, r.status);

  console.log("5. First signer (Priya)");
  const tomSince = Date.now() - 1000;
  await signAs("Priya", token1, sentSince, { wrongCode: true, withInitials: true });
  const invite2 = await waitMail(tom, "INVITATION", tomSince);
  const token2 = linkIn(invite2);
  check("second signer emailed after the first signs", Boolean(token2));
  const partial = (await mails(tomSince)).find((m) => m.kind === "PARTIALLY_SIGNED");
  check("sender told that Priya signed", Boolean(partial), (await mails(tomSince)).map((m) => `${m.kind}:${m.to}`));
  r = await a.call(`/api/signature-requests/${reqId}`);
  check("request is Partially signed", r.data.request.status === "PARTIALLY_SIGNED", r.data.request.status);
  r = await client().call(`/api/signature-requests/${token1}/review`);
  check("Priya's link now shows she has signed", r.status === 200 && r.data.problem === "SIGNED", r.data);

  console.log("6. Second signer (Tom) completes the request");
  const doneSince = Date.now() - 1000;
  await signAs("Tom", token2, tomSince, { text: "Head of Partnerships" });
  r = await waitFor(async () => {
    const x = await a.call(`/api/signature-requests/${reqId}`);
    return x.data.request.status === "COMPLETED" ? x : null;
  }, "request completed");
  const final = r.data.request;
  check("request completed with a final hash", final.status === "COMPLETED" && /^[a-f0-9]{64}$/.test(final.finalSha256 ?? ""), final);

  console.log("7. Final PDF, certificate, emails, audit");
  r = await a.call(`/api/signature-requests/${reqId}/download?file=final`);
  check("sender downloads the signed PDF; hash matches", r.status === 200 && sha256(r.bytes) === final.finalSha256, r.status);
  const finalDoc = await PDFDocument.load(r.bytes);
  check("signed PDF = 2 original pages + certificate", finalDoc.getPageCount() >= 3, finalDoc.getPageCount());
  check("download is served as an attachment", /attachment/.test(r.headers.get("content-disposition") ?? ""), r.headers.get("content-disposition"));
  r = await a.call(`/api/signature-requests/${reqId}/download?file=certificate`);
  check("certificate downloads", r.status === 200 && (await PDFDocument.load(r.bytes)).getPageCount() >= 1, r.status);
  r = await a.call(`/api/signature-requests/${reqId}/download?file=original`);
  check("original is unchanged", r.status === 200 && sha256(r.bytes) === version.pdfSha256, r.status);
  r = await b.call(`/api/signature-requests/${reqId}/download?file=final`);
  check("another user cannot download the signed PDF (404)", r.status === 404, r.status);
  r = await client().call(`/api/signature-requests/${token2}/document?file=final`);
  check("signer can download the same signed PDF from their link", r.status === 200 && sha256(r.bytes) === final.finalSha256, r.status);
  const completedMails = await waitFor(async () => {
    const m = (await mails(doneSince)).filter((x) => x.kind === "COMPLETED");
    return m.length >= 4 ? m : null;
  }, "completion emails");
  check("completed email to sender, both signers and CC", [priya, tom, legal].every((e) => completedMails.some((m) => m.to === e)), completedMails.map((m) => m.to));
  check("each completed email attaches the signed PDF and certificate", completedMails.every((m) => m.attachments.length === 2), completedMails.map((m) => m.attachments));
  r = await a.call(`/api/signature-requests/${reqId}/audit`);
  check("audit trail intact", r.status === 200 && r.data.integrity.ok === true, r.data.integrity);
  const actions = new Set(r.data.entries.map((e) => e.action));
  for (const act of ["REQUEST_SENT", "INVITATION_SENT", "DOCUMENT_VIEWED", "DOCUMENT_REVIEWED", "CONSENT_GIVEN", "OTP_SENT", "OTP_FAILED", "IDENTITY_VERIFIED", "SIGNED", "DOCUMENT_STAMPED", "REQUEST_COMPLETED"]) {
    check(`audit records ${act}`, actions.has(act), [...actions]);
  }
  check("audit entries carry IP and user agent for signer actions", r.data.entries.filter((e) => e.actor.startsWith("signer:")).every((e) => e.ip && e.userAgent), r.data.entries.slice(0, 3));
  r = await b.call(`/api/signature-requests/${reqId}/audit`);
  check("another user cannot read the audit trail (404)", r.status === 404, r.status);

  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    for (const sql of [
      ["UPDATE audit_logs SET actor = 'tampered' WHERE request_id = $1", "update"],
      ["DELETE FROM audit_logs WHERE request_id = $1", "delete"],
      ["UPDATE signature_events SET message = 'tampered' WHERE request_id = $1", "event update"],
    ]) {
      let blocked = false;
      try {
        await db.query(sql[0], [reqId]);
      } catch {
        blocked = true;
      }
      check(`database refuses audit ${sql[1]}`, blocked);
    }
    await db.end();
  } else note("DATABASE_URL not set; append-only triggers not checked from this script.");

  console.log("8. Decline, cancel, resend, delivery failure");
  const nda2 = await a.upload("/api/documents", "NDA v2.pdf", nda, "application/pdf", "NDA for decline test");
  const v2 = nda2.data.document.latest.id;
  let since = Date.now() - 1000;
  const dec = await newRequest(a, v2, {
    title: "Decline test",
    recipients: [
      { name: "Ann", email: `ann.${stamp}@a.example`, role: "SIGNER", routingOrder: 1 },
      { name: "Ben", email: `ben.${stamp}@b.example`, role: "SIGNER", routingOrder: 1 },
    ],
  });
  await signatureFieldsFor(a, dec.id, dec.recipients);
  r = await a.call(`/api/signature-requests/${dec.id}/send`, { body: { confirm: true } });
  check("parallel request sent", r.status === 200, r.data);
  const annTok = linkIn(await waitMail(`ann.${stamp}@a.example`, "INVITATION", since));
  const benTok = linkIn(await waitMail(`ben.${stamp}@b.example`, "INVITATION", since));
  check("parallel: both signers emailed at once", Boolean(annTok && benTok));
  r = await client().call(`/api/signature-requests/${annTok}/reject`, { body: { reason: "x" } });
  check("decline needs a reason", r.status === 400, r.data);
  r = await client().call(`/api/signature-requests/${annTok}/reject`, { body: { reason: "Clause 3 is wrong" } });
  check("Ann declines", r.status === 200, r.data);
  r = await a.call(`/api/signature-requests/${dec.id}`);
  check("request is Rejected", r.data.request.status === "REJECTED", r.data.request.status);
  r = await client().call(`/api/signature-requests/${benTok}/review`);
  check("Ben's link now says the request was declined", r.status === 200 && r.data.problem === "REJECTED" && r.data.fields.length === 0, r.data);
  r = await client().call(`/api/signature-requests/${benTok}/consent`, { body: { agree: true } });
  check("Ben can no longer act", r.status >= 400, r.status);
  check("sender told about the decline", Boolean(await waitMail((await a.call(`/api/signature-requests/${dec.id}`)).data.request.senderEmail, "REJECTED", since).catch(() => null)));

  since = Date.now() - 1000;
  const can = await newRequest(a, v2, { title: "Cancel test", recipients: [{ name: "Cara", email: `cara.${stamp}@c.example`, role: "SIGNER", routingOrder: 1 }] });
  await signatureFieldsFor(a, can.id, can.recipients);
  await a.call(`/api/signature-requests/${can.id}/send`, { body: { confirm: true } });
  const caraOld = linkIn(await waitMail(`cara.${stamp}@c.example`, "INVITATION", since));
  since = Date.now() - 1000;
  r = await a.call(`/api/signature-requests/${can.id}/resend`, { body: { recipientId: can.recipients[0].id } });
  check("sender re-issues Cara's link", r.status === 200 && r.data.ok === true, r.data);
  const caraNew = linkIn(await waitMail(`cara.${stamp}@c.example`, "INVITATION", since));
  check("new link differs from the old one", caraNew && caraNew !== caraOld);
  r = await client().call(`/api/signature-requests/${caraOld}/review`);
  check("old link no longer works", r.status === 404 || r.data?.problem === "REVOKED", r.data);
  r = await a.call(`/api/signature-requests/${can.id}/remind`, { body: {} });
  check("manual reminder sent", r.status === 200 && r.data.sent === 1, r.data);
  r = await a.call(`/api/signature-requests/${can.id}/cancel`, { body: { reason: "Wrong version" } });
  check("sender cancels", r.status === 200, r.data);
  r = await client().call(`/api/signature-requests/${caraNew}/review`);
  check("cancelled link shows a clear message", r.status === 200 && ["CANCELLED", "REVOKED"].includes(r.data.problem), r.data);
  r = await a.call(`/api/signature-requests/${can.id}/remind`, { body: {} });
  check("no reminders after cancelling", r.status === 409, r.data);
  check("Cara told about the cancellation", Boolean(await waitMail(`cara.${stamp}@c.example`, "CANCELLED", since).catch(() => null)));

  since = Date.now() - 1000;
  const bounce = await newRequest(a, v2, { title: "Bounce test", recipients: [{ name: "Nobody", email: `bounce.${stamp}@dead.example`, role: "SIGNER", routingOrder: 1 }] });
  await signatureFieldsFor(a, bounce.id, bounce.recipients);
  r = await a.call(`/api/signature-requests/${bounce.id}/send`, { body: { confirm: true } });
  check("request with an undeliverable address still sends", r.status === 200, r.data);
  r = await a.call(`/api/signature-requests/${bounce.id}`);
  check("undeliverable recipient is not marked Delivered", r.data.request.recipients[0].status === "SENT", r.data.request.recipients[0]);
  check("sender told the email could not be delivered", Boolean(await waitMail(r.data.request.senderEmail, "DELIVERY_FAILED", since).catch(() => null)));

  if (process.env.DATABASE_URL) {
    since = Date.now() - 1000;
    const exp = await newRequest(a, v2, { title: "Expiry test", recipients: [{ name: "Dev", email: `dev.${stamp}@d.example`, role: "SIGNER", routingOrder: 1 }] });
    await signatureFieldsFor(a, exp.id, exp.recipients);
    await a.call(`/api/signature-requests/${exp.id}/send`, { body: { confirm: true } });
    const devTok = linkIn(await waitMail(`dev.${stamp}@d.example`, "INVITATION", since));
    const { default: pg } = await import("pg");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    // Prisma stores UTC in "timestamp without time zone" columns.
    await db.query("UPDATE signature_requests SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1", [exp.id]);
    await db.end();
    r = await client().call(`/api/signature-requests/${devTok}/review`);
    check("a link past its expiry date stops working at once", r.status === 200 && r.data.problem === "EXPIRED" && r.data.fields.length === 0, r.data);
    r = await client().call(`/api/signature-requests/${devTok}/consent`, { body: { agree: true } });
    check("expired link cannot act", r.status >= 400, r.status);
    const expired = await waitFor(async () => {
      const x = await a.call(`/api/signature-requests/${exp.id}`);
      return x.data.request.status === "EXPIRED" ? x : null;
    }, "worker expires the request", 150_000, 3000).catch(() => null);
    check("worker marks the request Expired", Boolean(expired));
    if (expired) check("sender told the request expired", Boolean(await waitMail(expired.data.request.senderEmail, "EXPIRED", since).catch(() => null)));
  }

  console.log("9. Pages render");
  for (const p of ["/esign", `/esign/documents/${docId}`, "/esign/requests/new", `/esign/requests/${reqId}`, `/esign/requests/${dec.id}`]) {
    const res = await a.call(p);
    check(`${p} renders`, res.status === 200 && typeof res.data === "string" && !res.data.includes("Application error"), res.status);
  }
  r = await client().call("/esign");
  check("E-Signature section requires login", r.status === 307 || r.status === 308 || (typeof r.data === "string" && r.data.includes("/login")), r.status);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
