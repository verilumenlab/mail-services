"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { cn } from "@/lib/utils";

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return mod;
  });
  return pdfjsPromise;
}

/** Page size in PDF points with the page rotation applied (what the reader sees). */
export interface PageSize {
  width: number;
  height: number;
}

export function pageAnchorId(prefix: string, page: number): string {
  return `${prefix}-page-${page}`;
}

export function PdfPages({
  src,
  zoom = 1,
  idPrefix = "pdf",
  className,
  renderOverlay,
  onLoaded,
  onPageChange,
  onPageSeen,
}: {
  /** Same-origin URL that streams the PDF; credentials are sent. */
  src: string;
  zoom?: number;
  idPrefix?: string;
  className?: string;
  /** Rendered over each page, sized to the page in CSS pixels. */
  renderOverlay?: (page: number, size: { width: number; height: number }) => ReactNode;
  onLoaded?: (pages: PageSize[]) => void;
  onPageChange?: (page: number) => void;
  /** Called when at least half of a page (or half the viewport) has been on screen. */
  onPageSeen?: (page: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const onLoadedRef = useRef(onLoaded);
  const onPageChangeRef = useRef(onPageChange);
  const onPageSeenRef = useRef(onPageSeen);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onPageChangeRef.current = onPageChange;
    onPageSeenRef.current = onPageSeen;
  }, [onLoaded, onPageChange, onPageSeen]);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const task = pdfjs.getDocument({ url: src, withCredentials: true });
        loaded = await task.promise;
        if (cancelled) return;
        const list: PageSize[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const page = await loaded.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          list.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) return;
        setDoc(loaded);
        setSizes(list);
        onLoadedRef.current?.(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "The document could not be displayed.");
      }
    })();
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [src]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sizes.length) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const page = Number((e.target as HTMLElement).dataset.page);
          ratios.set(page, e.intersectionRatio);
          if (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= window.innerHeight * 0.5) onPageSeenRef.current?.(page);
        }
        let best = 0;
        let bestRatio = 0;
        ratios.forEach((r, p) => {
          if (r > bestRatio) {
            best = p;
            bestRatio = r;
          }
        });
        if (best) onPageChangeRef.current?.(best);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    el.querySelectorAll("[data-page]").forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [sizes]);

  if (error) {
    return <ErrorState title="The document could not be displayed" description="Reload the page. If this keeps happening, download the PDF instead." details={error} />;
  }

  const base = Math.max(0, width);
  return (
    <div ref={containerRef} className={cn("w-full overflow-x-auto", className)}>
      {!doc || !base ? (
        <div className="space-y-4">
          <Skeleton className="aspect-[1/1.414] w-full rounded-md" />
        </div>
      ) : (
        <div className="space-y-4" style={{ width: base * zoom }}>
          {sizes.map((size, i) => {
            const cssWidth = base * zoom;
            const cssHeight = (cssWidth * size.height) / size.width;
            return (
              <div
                key={i}
                id={pageAnchorId(idPrefix, i + 1)}
                data-page={i + 1}
                className="relative mx-auto overflow-hidden rounded-sm border border-line bg-white shadow-card"
                style={{ width: cssWidth, height: cssHeight }}
                aria-label={`Page ${i + 1} of ${sizes.length}`}
                role="group"
              >
                <PageCanvas doc={doc} pageNumber={i + 1} cssWidth={cssWidth} cssHeight={cssHeight} />
                {renderOverlay && <div className="absolute inset-0">{renderOverlay(i + 1, { width: cssWidth, height: cssHeight })}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PageCanvas({ doc, pageNumber, cssWidth, cssHeight }: { doc: PDFDocumentProxy; pageNumber: number; cssWidth: number; cssHeight: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, cssWidth, visible]);

  return <canvas ref={canvasRef} className="block select-none" style={{ width: cssWidth, height: cssHeight }} aria-hidden />;
}
