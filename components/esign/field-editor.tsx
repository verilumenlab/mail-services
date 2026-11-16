"use client";

import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Calendar, MousePointerClick, PenLine, Trash2, Type, UserRound, ZoomIn, ZoomOut, TextCursorInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Select } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { clampRect } from "@/lib/esign/geometry";
import { PdfPages } from "./pdf-pages";

export type FieldType = "SIGNATURE" | "INITIALS" | "DATE" | "NAME" | "TEXT";

export interface EditorField {
  key: string;
  recipientId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label?: string;
}

export interface EditorRecipient {
  id: string;
  name: string;
  email: string;
  role: "SIGNER" | "APPROVER" | "CC";
}

export const RECIPIENT_COLORS = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f"];

export const FIELD_META: Record<FieldType, { label: string; icon: typeof PenLine; w: number; h: number }> = {
  SIGNATURE: { label: "Signature", icon: PenLine, w: 0.26, h: 0.06 },
  INITIALS: { label: "Initials", icon: Type, w: 0.1, h: 0.05 },
  DATE: { label: "Date signed", icon: Calendar, w: 0.18, h: 0.03 },
  NAME: { label: "Full name", icon: UserRound, w: 0.26, h: 0.03 },
  TEXT: { label: "Text", icon: TextCursorInput, w: 0.26, h: 0.03 },
};

const DND_TYPE = "application/x-esign-field";

let seq = 0;
export function newFieldKey(): string {
  seq += 1;
  return `f${Date.now().toString(36)}${seq}`;
}

export function FieldEditor({
  pdfUrl,
  recipients,
  fields,
  onChange,
}: {
  pdfUrl: string;
  recipients: EditorRecipient[];
  fields: EditorField[];
  onChange: (fields: EditorField[]) => void;
}) {
  const signers = useMemo(() => recipients.filter((r) => r.role !== "CC"), [recipients]);
  const colorOf = useCallback((id: string) => RECIPIENT_COLORS[Math.max(0, recipients.findIndex((r) => r.id === id)) % RECIPIENT_COLORS.length], [recipients]);
  const [activeRecipient, setActiveRecipient] = useState(signers[0]?.id ?? "");
  const [armed, setArmed] = useState<FieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const recipientId = signers.some((s) => s.id === activeRecipient) ? activeRecipient : signers[0]?.id ?? "";
  const selectedField = fields.find((f) => f.key === selected) ?? null;

  function update(key: string, patch: Partial<EditorField>) {
    onChange(fields.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  function remove(key: string) {
    onChange(fields.filter((f) => f.key !== key));
    setSelected(null);
  }

  function place(type: FieldType, pageNumber: number, nx: number, ny: number) {
    if (!recipientId) return;
    const meta = FIELD_META[type];
    const rect = clampRect({ x: nx - meta.w / 2, y: ny - meta.h / 2, width: meta.w, height: meta.h });
    const field: EditorField = { key: newFieldKey(), recipientId, type, page: pageNumber, ...rect, required: true };
    onChange([...fields, field]);
    setSelected(field.key);
    setArmed(null);
  }

  function pointFromEvent(el: HTMLElement, clientX: number, clientY: number) {
    const box = el.getBoundingClientRect();
    return { nx: (clientX - box.left) / box.width, ny: (clientY - box.top) / box.height };
  }

  const renderOverlay = (pageNumber: number, size: { width: number; height: number }) => (
    <div
      className={cn("absolute inset-0", armed && "cursor-crosshair")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPE)) e.preventDefault();
      }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData(DND_TYPE) as FieldType;
        if (!type || !FIELD_META[type]) return;
        e.preventDefault();
        const p = pointFromEvent(e.currentTarget, e.clientX, e.clientY);
        place(type, pageNumber, p.nx, p.ny);
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (armed) {
          const p = pointFromEvent(e.currentTarget, e.clientX, e.clientY);
          place(armed, pageNumber, p.nx, p.ny);
        } else setSelected(null);
      }}
    >
      {fields
        .filter((f) => f.page === pageNumber)
        .map((f) => (
          <PlacedField
            key={f.key}
            field={f}
            size={size}
            color={colorOf(f.recipientId)}
            recipient={recipients.find((r) => r.id === f.recipientId)}
            selected={selected === f.key}
            onSelect={() => setSelected(f.key)}
            onMove={(patch) => update(f.key, patch)}
            onDelete={() => remove(f.key)}
          />
        ))}
    </div>
  );

  if (!signers.length) {
    return <p className="type-body-sm text-muted">Add at least one signer or approver before placing fields.</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)] lg:self-start">
        <Field label="Placing fields for" htmlFor="field-recipient">
          <Select id="field-recipient" value={recipientId} onChange={(e) => setActiveRecipient(e.target.value)}>
            {signers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.role === "APPROVER" ? "approver" : "signer"})
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap gap-1.5" aria-label="Recipient colours">
          {signers.map((s) => (
            <span key={s.id} className="type-caption inline-flex items-center gap-1.5 rounded-sm border border-line px-1.5 py-0.5 text-muted">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorOf(s.id) }} aria-hidden />
              {s.name}
            </span>
          ))}
        </div>
        <div>
          <p className="type-mono-label mb-1.5 text-muted">Fields</p>
          <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
            {(Object.keys(FIELD_META) as FieldType[]).map((type) => {
              const meta = FIELD_META[type];
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DND_TYPE, type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => setArmed((a) => (a === type ? null : type))}
                  aria-pressed={armed === type}
                  className={cn(
                    "flex min-h-10 items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                    armed === type ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-muted hover:border-accent/40 hover:text-fg",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" style={{ color: colorOf(recipientId) }} aria-hidden />
                  {meta.label}
                </button>
              );
            })}
          </div>
          <p className="type-caption mt-2 text-subtle">
            <MousePointerClick className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            Drag a field onto the page, or tap a field and then tap where it goes.
          </p>
        </div>

        {selectedField && (
          <div className="space-y-3 rounded-md border border-line bg-panel-2 p-3">
            <p className="type-mono-label text-muted">Selected: {FIELD_META[selectedField.type].label}</p>
            <Field label="Assigned to" htmlFor="sel-recipient">
              <Select id="sel-recipient" value={selectedField.recipientId} onChange={(e) => update(selectedField.key, { recipientId: e.target.value })}>
                {signers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm text-fg">
              <Checkbox checked={selectedField.required} onChange={(e) => update(selectedField.key, { required: e.target.checked })} />
              Required
            </label>
            {selectedField.type === "TEXT" && (
              <Field label="Label" htmlFor="sel-label">
                <input
                  id="sel-label"
                  className="h-9 w-full rounded-md border border-line-strong bg-panel px-2 text-sm text-fg"
                  maxLength={80}
                  value={selectedField.label ?? ""}
                  onChange={(e) => update(selectedField.key, { label: e.target.value })}
                  placeholder="e.g. Job title"
                />
              </Field>
            )}
            <Button variant="danger" size="sm" onClick={() => remove(selectedField.key)}>
              <Trash2 aria-hidden />
              Remove field
            </Button>
          </div>
        )}
        <p className="type-caption text-subtle">
          {fields.length} field{fields.length === 1 ? "" : "s"} placed
        </p>
      </aside>

      <div className="min-w-0">
        <div className="sticky top-[var(--topbar-h)] z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel/95 px-3 py-2 backdrop-blur">
          <span className="type-caption text-muted" aria-live="polite">
            {armed ? `Tap the page to place: ${FIELD_META[armed].label}` : pages ? `Page ${page} of ${pages}` : "Loading…"}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} disabled={zoom <= 0.5}>
              <ZoomOut />
            </Button>
            <span className="type-data w-12 text-center text-xs text-muted">{Math.round(zoom * 100)}%</span>
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} disabled={zoom >= 3}>
              <ZoomIn />
            </Button>
          </div>
        </div>
        <PdfPages src={pdfUrl} zoom={zoom} idPrefix="editor" renderOverlay={renderOverlay} onLoaded={(p) => setPages(p.length)} onPageChange={setPage} />
      </div>
    </div>
  );
}

function PlacedField({
  field,
  size,
  color,
  recipient,
  selected,
  onSelect,
  onMove,
  onDelete,
}: {
  field: EditorField;
  size: { width: number; height: number };
  color: string;
  recipient?: EditorRecipient;
  selected: boolean;
  onSelect: () => void;
  onMove: (patch: Partial<EditorField>) => void;
  onDelete: () => void;
}) {
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startY: number; orig: EditorField } | null>(null);
  const meta = FIELD_META[field.type];

  function start(mode: "move" | "resize", e: ReactPointerEvent<HTMLElement>) {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: field };
  }

  function move(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / size.width;
    const dy = (e.clientY - d.startY) / size.height;
    const next =
      d.mode === "move"
        ? clampRect({ x: d.orig.x + dx, y: d.orig.y + dy, width: d.orig.width, height: d.orig.height })
        : clampRect({ x: d.orig.x, y: d.orig.y, width: Math.min(1 - d.orig.x, d.orig.width + dx), height: Math.min(1 - d.orig.y, d.orig.height + dy) });
    onMove(next);
  }

  function end() {
    drag.current = null;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${meta.label} for ${recipient?.name ?? "recipient"}${field.required ? ", required" : ""}`}
      aria-pressed={selected}
      className={cn("absolute flex touch-none select-none items-center justify-center rounded-sm border-2 text-[11px] font-medium", selected ? "z-10 shadow-lift" : "z-[1]")}
      style={{
        left: `${field.x * 100}%`,
        top: `${field.y * 100}%`,
        width: `${field.width * 100}%`,
        height: `${field.height * 100}%`,
        borderColor: color,
        background: `${color}22`,
        color,
        cursor: "move",
      }}
      onPointerDown={(e) => start("move", e)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.02 : 0.005;
        const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[e.key]) {
          e.preventDefault();
          const [mx, my] = moves[e.key];
          onMove(clampRect({ x: field.x + mx, y: field.y + my, width: field.width, height: field.height }));
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDelete();
        }
      }}
    >
      <span className="pointer-events-none truncate px-1">
        {meta.label}
        {field.required ? " *" : ""}
      </span>
      {selected && (
        <span
          aria-hidden
          className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 bg-white"
          style={{ borderColor: color }}
          onPointerDown={(e) => start("resize", e)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
    </div>
  );
}
