"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Download, FileText, Lock, MailCheck, PenLine, ShieldCheck, XCircle, ZoomIn, ZoomOut } from "lucide-react";
import { Alert } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { pageAnchorId, PdfPages } from "./pdf-pages";
import { renderTypedSignature, SignaturePad, type AdoptedSignature, type SignatureFont } from "./signature-pad";

type FieldType = "SIGNATURE" | "INITIALS" | "DATE" | "NAME" | "TEXT";

interface View {
  problem: string | null;
  problemText: string | null;
  request?: {
    title: string;
    documentTitle: string;
    senderName: string;
    senderEmail: string;
    senderCompany: string | null;
    message: string | null;
    expiresAt: string;
    status: string;
    pageCount: number;
    documentSha256: string | null;
    finalSha256: string | null;
    signatureLevel: string;
    signingOrder: string;
    progress: { signed: number; total: number };
  };
  me?: {
    name: string;
    email: string;
    role: string;
    status: string;
    viewed: boolean;
    reviewed: boolean;
    consented: boolean;
    emailVerified: boolean;
    smsRequired: boolean;
    smsVerified: boolean;
    emailDestination: string;
    smsDestination: string | null;
    sessionActive: boolean;
    signedAt: string | null;
  };
  fields?: { id: string; type: FieldType; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null }[];
  consent?: { version: string; text: string };
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 3)
    .join("");
}

function message(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong. Try again.";
}

export function SignerApp({ token, fonts }: { token: string; fonts: SignatureFont[] }) {
  const toast = useToast();
  const base = `/api/signature-requests/${token}`;
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [codeSent, setCodeSent] = useState<{ channel: "EMAIL" | "SMS"; destination: string } | null>(null);
  const [code, setCode] = useState("");
  const [signature, setSignature] = useState<AdoptedSignature | null>(null);
  const [initialsText, setInitialsText] = useState("");
  const [initialsPng, setInitialsPng] = useState<string | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [intent, setIntent] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [today] = useState(() => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }));

  const apply = useCallback((v: View) => {
    setView(v);
    setLoadError(null);
    if (v.me) setInitialsText((t) => t || initialsOf(v.me!.name));
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api<View>(`${base}/review`));
    } catch (err) {
      setLoadError(message(err));
    }
  }, [base, apply]);

  useEffect(() => {
    api<View>(`${base}/review`).then(apply, (err) => setLoadError(message(err)));
  }, [base, apply]);

  const req = view?.request;
  const me = view?.me;
  const fields = useMemo(() => view?.fields ?? [], [view]);
  const pageCount = req?.pageCount ?? 0;
  const needsInitials = fields.some((f) => f.type === "INITIALS");
  const active = view && !view.problem;
  const reviewed = Boolean(me?.reviewed) || (pageCount > 0 && seen.size >= pageCount);

  useEffect(() => {
    let cancelled = false;
    if (!needsInitials || !initialsText.trim()) return;
    const family = (signature?.fontStyle && fonts.find((f) => f.label === signature.fontStyle)?.family) || fonts[0]?.family;
    if (!family) return;
    void renderTypedSignature(initialsText.trim(), family, 80).then((png) => {
      if (!cancelled) setInitialsPng(png);
    });
    return () => {
      cancelled = true;
    };
  }, [needsInitials, initialsText, signature, fonts]);

  useEffect(() => {
    if (!active || !me || me.reviewed || pageCount === 0 || seen.size < pageCount) return;
    void api(`${base}/review`, { method: "POST", body: { pagesSeen: seen.size } })
      .then(() => load())
      .catch(() => undefined);
  }, [active, me, pageCount, seen, base, load]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const textMissing = fields.some((f) => f.type === "TEXT" && f.required && !(values[f.id] ?? "").trim());
  const verified = Boolean(me?.sessionActive);
  const canSign = Boolean(active && reviewed && me?.consented && verified && signature && (!needsInitials || initialsPng) && !textMissing && intent);

  function goToPage(n: number) {
    const target = Math.min(Math.max(1, n), pageCount);
    document.getElementById(pageAnchorId("signer", target))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (loadError && !view) {
    return (
      <Shell>
        <Card>
          <CardBody className="space-y-2 py-10 text-center">
            <XCircle className="mx-auto h-8 w-8 text-danger" aria-hidden />
            <p className="type-h3 text-fg">This link cannot be opened</p>
            <p className="type-body-sm text-muted">{loadError}</p>
          </CardBody>
        </Card>
      </Shell>
    );
  }
  if (!view || !req || !me) {
    return (
      <Shell>
        <LoadingState variant="page" message="Opening the document" />
      </Shell>
    );
  }

  const overlay = (pageNumber: number) =>
    fields
      .filter((f) => f.page === pageNumber)
      .map((f) => {
        const filled =
          f.type === "SIGNATURE" ? Boolean(signature) : f.type === "INITIALS" ? Boolean(initialsPng) : f.type === "TEXT" ? Boolean((values[f.id] ?? "").trim()) : true;
        const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
        const ring = filled ? "border-emerald-500 bg-emerald-50/40" : f.required ? "border-amber-500 bg-amber-100/60 animate-pulse" : "border-sky-500 bg-sky-50/50";
        if (!active) return null;
        if (f.type === "TEXT") {
          return (
            <input
              key={f.id}
              aria-label={f.label || "Text field"}
              placeholder={f.label || "Type here"}
              value={values[f.id] ?? ""}
              maxLength={500}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
              className={cn("absolute rounded-sm border-2 px-1 text-[clamp(8px,1.4vw,13px)] text-slate-900 outline-none", ring)}
              style={style}
            />
          );
        }
        const content =
          f.type === "SIGNATURE" && signature ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={signature.image} alt="Your signature" className="h-full w-full object-contain" />
          ) : f.type === "INITIALS" && initialsPng ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={initialsPng} alt="Your initials" className="h-full w-full object-contain" />
          ) : f.type === "DATE" ? (
            <span className="truncate text-[clamp(8px,1.4vw,13px)] text-slate-900">{today}</span>
          ) : f.type === "NAME" ? (
            <span className="truncate text-[clamp(8px,1.4vw,13px)] text-slate-900">{me.name}</span>
          ) : (
            <span className="truncate text-[clamp(8px,1.3vw,12px)] font-semibold text-amber-800">{f.type === "SIGNATURE" ? "Sign here" : "Initials"}{f.required ? " *" : ""}</span>
          );
        return f.type === "SIGNATURE" || f.type === "INITIALS" ? (
          <button key={f.id} type="button" onClick={() => setPadOpen(true)} className={cn("absolute flex items-center justify-center rounded-sm border-2 p-0.5", ring)} style={style} aria-label={f.type === "SIGNATURE" ? "Add your signature" : "Add your initials"}>
            {content}
          </button>
        ) : (
          <div key={f.id} className={cn("absolute flex items-center rounded-sm border-2 px-1", ring)} style={style}>
            {content}
          </div>
        );
      });

  const readable = !view.problem || ["SIGNED", "NOT_YOUR_TURN", "FINALIZING"].includes(view.problem);
  const sigFields = fields.filter((f) => f.type === "SIGNATURE" || f.type === "INITIALS").length;

  return (
    <Shell brand={req.senderCompany || req.senderName}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="type-mono-label text-accent-strong">{me.role === "APPROVER" ? "Review and approve" : "Review and sign"}</p>
          <h1 className="type-h2 mt-1 break-words text-fg">{req.title}</h1>
          <p className="type-body-sm mt-1 text-muted">
            From {req.senderName} &lt;{req.senderEmail}&gt; · {req.documentTitle} · {pageCount} page{pageCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">
            <ShieldCheck className="h-3 w-3" aria-hidden /> Electronic signature
          </Badge>
          <Badge tone="neutral">
            {req.progress.signed}/{req.progress.total} signed
          </Badge>
        </div>
      </div>

      {view.problem && (
        <div className="mb-4">
          <Alert tone={view.problem === "COMPLETED" || view.problem === "SIGNED" ? "success" : view.problem === "NOT_YOUR_TURN" || view.problem === "FINALIZING" ? "info" : "warning"} title={view.problemText ?? ""}>
            {view.problem === "COMPLETED" && (
              <div className="mt-2 flex flex-wrap gap-2">
                <a href={`${base}/document?file=final`} className={buttonClasses({ variant: "primary", size: "sm" })}>
                  <Download aria-hidden /> Signed PDF
                </a>
                <a href={`${base}/document?file=certificate`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                  <FileText aria-hidden /> Completion certificate
                </a>
              </div>
            )}
            {view.problem === "SIGNED" && <p>We will email you the signed document when everyone has signed.</p>}
          </Alert>
        </div>
      )}

      {readable && view.problem !== "COMPLETED" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <div className="sticky top-0 z-10 mb-3 flex items-center justify-between gap-2 rounded-md border border-line bg-panel/95 px-2 py-1.5 backdrop-blur">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" aria-label="Previous page" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
                  <ChevronLeft />
                </Button>
                <span className="type-caption min-w-20 text-center text-muted" aria-live="polite">
                  Page {page} of {pageCount}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label="Next page" onClick={() => goToPage(page + 1)} disabled={page >= pageCount}>
                  <ChevronRight />
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} disabled={zoom <= 0.5}>
                  <ZoomOut />
                </Button>
                <span className="type-data w-11 text-center text-xs text-muted">{Math.round(zoom * 100)}%</span>
                <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} disabled={zoom >= 3}>
                  <ZoomIn />
                </Button>
              </div>
            </div>
            <PdfPages
              src={`${base}/document`}
              zoom={zoom}
              idPrefix="signer"
              renderOverlay={overlay}
              onPageChange={setPage}
              onPageSeen={(p) => setSeen((s) => (s.has(p) ? s : new Set(s).add(p)))}
            />
          </div>

          {active && (
            <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start" aria-label="Signing steps">
              {req.message && (
                <Card variant="info">
                  <CardBody className="p-4">
                    <p className="type-mono-label text-muted">Message from {req.senderName}</p>
                    <p className="type-body-sm mt-1 whitespace-pre-wrap text-fg">{req.message}</p>
                  </CardBody>
                </Card>
              )}
              <Card>
                <CardBody className="space-y-4 p-4">
                  {error && <Alert tone="danger">{error}</Alert>}

                  <Step n={1} done={reviewed} title="Review the document">
                    {reviewed ? (
                      <p className="type-caption text-muted">All {pageCount} pages reviewed.</p>
                    ) : (
                      <>
                        <p className="type-caption text-muted">
                          Scroll through every page. {seen.size} of {pageCount} seen.
                        </p>
                        <Button variant="secondary" size="sm" onClick={() => goToPage([...Array(pageCount)].findIndex((_, i) => !seen.has(i + 1)) + 1 || pageCount)}>
                          Go to next unread page
                        </Button>
                      </>
                    )}
                  </Step>

                  <Step n={2} done={me.consented} title="Agree to sign electronically" disabled={!reviewed}>
                    {!me.consented && reviewed && (
                      <div className="space-y-2">
                        <p className="type-caption max-h-32 overflow-y-auto rounded border border-line bg-panel-2 p-2 text-muted">{view.consent?.text}</p>
                        <label className="flex items-start gap-2 text-sm text-fg">
                          <Checkbox className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />I agree to use electronic records and signatures.
                        </label>
                        <Button size="sm" variant="secondary" disabled={!agree} loading={busy === "consent"} onClick={() => run("consent", async () => {
                          await api(`${base}/consent`, { method: "POST", body: { agree: true } });
                          await load();
                        })}>
                          Continue
                        </Button>
                      </div>
                    )}
                  </Step>

                  <Step n={3} done={verified} title="Confirm it is you" disabled={!me.consented}>
                    {me.consented && !verified && (
                      <VerifyStep
                        me={me}
                        busy={busy}
                        codeSent={codeSent}
                        code={code}
                        setCode={setCode}
                        onSend={(channel) =>
                          run("send-code", async () => {
                            const r = await api<{ destination: string }>(`${base}/verify`, { method: "POST", body: { channel } });
                            setCodeSent({ channel, destination: r.destination });
                            setCode("");
                            toast.info("Code sent", `Check ${r.destination}`);
                          })
                        }
                        onVerify={(channel) =>
                          run("verify", async () => {
                            const r = await api<{ sessionActive: boolean; needSms: boolean }>(`${base}/verify`, { method: "POST", body: { channel, code } });
                            setCodeSent(null);
                            setCode("");
                            if (r.needSms) toast.info("Email confirmed", "Now confirm the code sent to your phone.");
                            await load();
                          })
                        }
                      />
                    )}
                  </Step>

                  <Step n={4} open done={Boolean(signature) && (!needsInitials || Boolean(initialsPng)) && !textMissing} title={me.role === "APPROVER" ? "Add your signature to approve" : "Add your signature"}>
                    <div className="space-y-2">
                      {signature ? (
                        <div className="flex items-center gap-3 rounded-md border border-line bg-white p-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={signature.image} alt="Your adopted signature" className="h-10 max-w-[10rem] object-contain" />
                          <Button variant="ghost" size="xs" onClick={() => setPadOpen(true)}>
                            Change
                          </Button>
                        </div>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => setPadOpen(true)}>
                          <PenLine aria-hidden /> Draw, type or upload
                        </Button>
                      )}
                      {needsInitials && (
                        <Field label="Initials" htmlFor="initials">
                          <Input id="initials" value={initialsText} maxLength={6} onChange={(e) => setInitialsText(e.target.value)} />
                        </Field>
                      )}
                      {fields.some((f) => f.type === "TEXT") && (
                        <div className="space-y-2">
                          {fields
                            .filter((f) => f.type === "TEXT")
                            .map((f) => (
                              <Field key={f.id} label={`${f.label || "Text"}${f.required ? " *" : ""}`} htmlFor={`txt-${f.id}`}>
                                <Input id={`txt-${f.id}`} value={values[f.id] ?? ""} maxLength={500} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))} />
                              </Field>
                            ))}
                        </div>
                      )}
                      <p className="type-caption text-subtle">
                        {sigFields ? `Your signature is placed in ${sigFields} field${sigFields === 1 ? "" : "s"}.` : "Your signature is recorded with the request."} The date and your name are filled in automatically.
                      </p>
                    </div>
                  </Step>

                  <div className="space-y-3 border-t border-line pt-3">
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <Checkbox className="mt-0.5" checked={intent} onChange={(e) => setIntent(e.target.checked)} />
                      I have reviewed this document and I intend to {me.role === "APPROVER" ? "approve and sign" : "sign"} it electronically.
                    </label>
                    <Button
                      variant="primary"
                      className="w-full"
                      disabled={!canSign}
                      loading={busy === "sign"}
                      onClick={() =>
                        run("sign", async () => {
                          await api(`${base}/sign`, {
                            method: "POST",
                            body: {
                              signature: { method: signature!.method, image: signature!.image, initialsImage: needsInitials ? initialsPng ?? undefined : undefined, typedName: signature!.typedName, fontStyle: signature!.fontStyle },
                              values,
                              documentSha256: req.documentSha256,
                              agree: true,
                            },
                          });
                          toast.success("Signed", "Thank you. Everyone will get the signed document by email when it is complete.");
                          await load();
                        })
                      }
                    >
                      <Lock aria-hidden /> {me.role === "APPROVER" ? "Approve and sign" : "Sign document"}
                    </Button>
                    <Button variant="ghost" size="sm" className="w-full" onClick={() => setDeclineOpen(true)}>
                      Decline to sign
                    </Button>
                    <p className="type-caption text-subtle">Link expires {new Date(req.expiresAt).toLocaleString()}.</p>
                  </div>
                </CardBody>
              </Card>
            </aside>
          )}
        </div>
      )}

      <Modal open={padOpen} onClose={() => setPadOpen(false)} title="Add your signature" description="This signature is placed in every signature field assigned to you.">
        <SignaturePad
          defaultName={me.name}
          fonts={fonts}
          onAdopt={(s) => {
            setSignature(s);
            setPadOpen(false);
          }}
        />
      </Modal>

      <Modal
        open={declineOpen}
        onClose={() => setDeclineOpen(false)}
        title="Decline to sign"
        description="The request will be closed for everyone and the sender will be told your reason."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeclineOpen(false)}>
              Keep reviewing
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              loading={busy === "reject"}
              onClick={() =>
                run("reject", async () => {
                  await api(`${base}/reject`, { method: "POST", body: { reason: reason.trim() } });
                  setDeclineOpen(false);
                  await load();
                })
              }
            >
              Decline
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="decline-reason">
          <Textarea id="decline-reason" rows={4} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the payment terms in clause 4 are wrong." />
        </Field>
      </Modal>
    </Shell>
  );
}

function Shell({ children, brand }: { children: React.ReactNode; brand?: string }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-panel/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
            <ShieldCheck className="h-5 w-5 shrink-0 text-accent-strong" aria-hidden />
            <span className="truncate">{brand ?? "Secure document signing"}</span>
          </span>
          <span className="type-caption hidden text-muted sm:inline">Secure electronic signing</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-3 py-5 sm:px-4">{children}</main>
    </div>
  );
}

function Step({ n, title, done, disabled, open, children }: { n: number; title: string; done: boolean; disabled?: boolean; open?: boolean; children?: React.ReactNode }) {
  return (
    <section className={cn("space-y-2", disabled && !done && "opacity-50")} aria-label={`Step ${n}: ${title}`}>
      <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-panel-3 text-[11px] text-muted">{n}</span>
        )}
        {title}
      </h2>
      {(open || !done) && !disabled && <div className="pl-7">{children}</div>}
    </section>
  );
}

function VerifyStep({
  me,
  busy,
  codeSent,
  code,
  setCode,
  onSend,
  onVerify,
}: {
  me: NonNullable<View["me"]>;
  busy: string | null;
  codeSent: { channel: "EMAIL" | "SMS"; destination: string } | null;
  code: string;
  setCode: (v: string) => void;
  onSend: (channel: "EMAIL" | "SMS") => void;
  onVerify: (channel: "EMAIL" | "SMS") => void;
}) {
  const channel: "EMAIL" | "SMS" = !me.emailVerified ? "EMAIL" : "SMS";
  const destination = channel === "EMAIL" ? me.emailDestination : me.smsDestination ?? "your phone";
  if (codeSent && codeSent.channel === channel) {
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          onVerify(channel);
        }}
      >
        <Field label={`Code sent to ${codeSent.destination}`} htmlFor="otp">
          <Input
            id="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="type-data text-center text-lg tracking-[0.5em]"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="secondary" disabled={code.length !== 6} loading={busy === "verify"}>
            Confirm code
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onSend(channel)} loading={busy === "send-code"}>
            Send a new code
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="space-y-2">
      <p className="type-caption text-muted">
        We will send a 6-digit code {channel === "EMAIL" ? "by email" : "by SMS"} to {destination}. It expires in 10 minutes.
      </p>
      <Button size="sm" variant="secondary" onClick={() => onSend(channel)} loading={busy === "send-code"}>
        <MailCheck aria-hidden /> Send code
      </Button>
    </div>
  );
}
