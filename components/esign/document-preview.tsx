"use client";

import { useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PdfPages } from "./pdf-pages";

export function DocumentPreview({ src }: { src: string }) {
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  return (
    <div>
      <div className="sticky top-[var(--topbar-h)] z-10 mb-3 flex items-center justify-between gap-2 rounded-md border border-line bg-panel/95 px-3 py-2 backdrop-blur">
        <span className="type-caption text-muted" aria-live="polite">
          {pages ? `Page ${page} of ${pages}` : "Loading…"}
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
      <PdfPages src={src} zoom={zoom} idPrefix="preview" onLoaded={(p) => setPages(p.length)} onPageChange={setPage} />
    </div>
  );
}
