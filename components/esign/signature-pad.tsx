"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Eraser, PenLine, Type, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { cn } from "@/lib/utils";

export type SignatureMethod = "DRAWN" | "UPLOADED" | "TYPED";

export interface SignatureFont {
  id: string;
  label: string;
  family: string;
}

export interface AdoptedSignature {
  method: SignatureMethod;
  image: string;
  typedName?: string;
  fontStyle?: string;
}

const INK = "#0f1f4d";
const MAX_UPLOAD = 2 * 1024 * 1024;

/** Crops a canvas to its non-transparent pixels plus padding and returns a PNG data URL, or null if empty. */
function trimmedPng(canvas: HTMLCanvasElement, pad = 12): string | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxX - minX < 4 || maxY - minY < 2) return null;
  const out = document.createElement("canvas");
  out.width = maxX - minX + pad * 2;
  out.height = maxY - minY + pad * 2;
  out.getContext("2d")!.drawImage(canvas, minX, minY, maxX - minX + 1, maxY - minY + 1, pad, pad, maxX - minX + 1, maxY - minY + 1);
  return out.toDataURL("image/png");
}

/** Renders text in a signature font to a trimmed PNG. */
export async function renderTypedSignature(text: string, family: string, size = 96): Promise<string | null> {
  if (!text.trim()) return null;
  await document.fonts.load(`${size}px ${family}`).catch(() => undefined);
  const canvas = document.createElement("canvas");
  const probe = canvas.getContext("2d")!;
  probe.font = `${size}px ${family}`;
  canvas.width = Math.ceil(probe.measureText(text).width + size);
  canvas.height = Math.ceil(size * 1.8);
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${size}px ${family}`;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, canvas.height / 2);
  return trimmedPng(canvas);
}

function DrawPad({ onChange }: { onChange: (png: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const setup = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = INK;
    };
    // Resizing a canvas wipes it, so the drawing has to start over.
    const onResize = () => {
      if (Math.round(canvas.getBoundingClientRect().width * Math.min(window.devicePixelRatio || 1, 3)) === canvas.width) return;
      setup();
      setEmpty(true);
      onChange(null);
    };
    setup();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onChange]);

  function point(e: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, p: e.pressure && e.pointerType === "pen" ? e.pressure : 0.5 };
  }

  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture fails for pointers the browser no longer tracks; drawing still works without it.
    }
    drawing.current = true;
    const p = point(e);
    last.current = p;
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.beginPath();
    ctx.fillStyle = INK;
    ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const p = point(e);
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.lineWidth = 1.6 + p.p * 2;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const png = trimmedPng(canvasRef.current!);
    setEmpty(!png);
    onChange(png);
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <div className="relative rounded-md border border-line-strong bg-white">
        <canvas
          ref={canvasRef}
          className="block h-44 w-full touch-none cursor-crosshair sm:h-52"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
          aria-label="Signature drawing area. Draw with your mouse, finger or stylus."
          role="img"
        />
        <span aria-hidden className="pointer-events-none absolute inset-x-6 bottom-10 border-b border-dashed border-slate-300" />
        {empty && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">Sign here</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={clear}>
        <Eraser aria-hidden />
        Clear
      </Button>
    </div>
  );
}

async function uploadToPng(file: File): Promise<string> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error("Upload a PNG or JPG image.");
  if (file.size > MAX_UPLOAD) throw new Error("The image must be smaller than 2 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("This image could not be read."));
      el.src = url;
    });
    const scale = Math.min(1, 1200 / img.width, 600 / img.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const [r, g, b] = [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
      if (r > 225 && g > 225 && b > 225) pixels.data[i + 3] = 0;
    }
    ctx.putImageData(pixels, 0, 0);
    const png = trimmedPng(canvas, 6);
    if (!png) throw new Error("The image looks empty. Use a photo or scan of your signature on white paper.");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function SignaturePad({ defaultName, fonts, onAdopt }: { defaultName: string; fonts: SignatureFont[]; onAdopt: (sig: AdoptedSignature) => void }) {
  const [tab, setTab] = useState<SignatureMethod>("DRAWN");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [typedName, setTypedName] = useState(defaultName);
  const [fontId, setFontId] = useState(fonts[0]?.id ?? "");
  const [typedPreview, setTypedPreview] = useState<string | null>(null);
  const font = fonts.find((f) => f.id === fontId) ?? fonts[0];

  useEffect(() => {
    let cancelled = false;
    if (tab !== "TYPED" || !font) return;
    void renderTypedSignature(typedName.trim(), font.family).then((png) => {
      if (!cancelled) setTypedPreview(png);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, typedName, font]);

  const current = tab === "DRAWN" ? drawn : tab === "UPLOADED" ? uploaded : typedName.trim() ? typedPreview : null;

  const tabs: { id: SignatureMethod; label: string; icon: typeof PenLine }[] = [
    { id: "DRAWN", label: "Draw", icon: PenLine },
    { id: "TYPED", label: "Type", icon: Type },
    { id: "UPLOADED", label: "Upload", icon: Upload },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md border border-line bg-panel-2 p-1" role="tablist" aria-label="How do you want to sign?">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn("flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded text-sm transition-colors", tab === t.id ? "bg-panel text-fg shadow-card" : "text-muted hover:text-fg")}
          >
            <t.icon className="h-4 w-4" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "DRAWN" && <DrawPad onChange={setDrawn} />}

      {tab === "TYPED" && (
        <div className="space-y-3">
          <Field label="Your full name" htmlFor="typed-name">
            <Input id="typed-name" value={typedName} maxLength={120} onChange={(e) => setTypedName(e.target.value)} autoComplete="name" />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Signature style">
            {fonts.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={fontId === f.id}
                onClick={() => setFontId(f.id)}
                className={cn("flex h-16 items-center justify-center overflow-hidden rounded-md border bg-white px-3 text-3xl text-[#0f1f4d]", fontId === f.id ? "border-accent ring-2 ring-accent/40" : "border-line-strong")}
                style={{ fontFamily: f.family }}
                aria-label={f.label}
              >
                <span className="truncate">{typedName.trim() || "Your name"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "UPLOADED" && (
        <div className="space-y-2">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-strong bg-panel-2 px-4 py-8 text-center hover:border-accent/40">
            <Upload className="h-5 w-5 text-accent-strong" aria-hidden />
            <span className="text-sm font-medium text-fg">Choose a PNG or JPG of your signature</span>
            <span className="type-caption text-muted">Dark ink on white paper works best. Max 2 MB.</span>
            <input
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              onChange={async (e) => {
                setUploadError(null);
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  setUploaded(await uploadToPng(f));
                } catch (err) {
                  setUploaded(null);
                  setUploadError(err instanceof Error ? err.message : "This image could not be used.");
                }
              }}
            />
          </label>
          {uploadError && (
            <p className="type-caption text-danger" role="alert">
              {uploadError}
            </p>
          )}
        </div>
      )}

      <div>
        <p className="type-mono-label mb-1.5 text-muted">Preview</p>
        <div className="flex h-24 items-center justify-center rounded-md border border-line bg-white p-2">
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current} alt="Your signature" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-sm text-slate-400">Your signature will appear here</span>
          )}
        </div>
      </div>

      <Button
        variant="primary"
        className="w-full"
        disabled={!current}
        onClick={() => current && onAdopt({ method: tab, image: current, typedName: tab === "TYPED" ? typedName.trim() : undefined, fontStyle: tab === "TYPED" ? font?.label : undefined })}
      >
        Adopt this signature
      </Button>
    </div>
  );
}
