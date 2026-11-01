/** Measure glyph advances in the browser's actual text layout, including native
 * WebView text zoom and font fallback. The React-owned probe lives outside both
 * selectable text and the paragraph block used for pagination.
 */
export function measureReaderIndent(probe: HTMLElement): number | undefined {
  try {
    const width = probe.getBoundingClientRect().width;
    return Number.isFinite(width) && width > 0 ? width : undefined;
  } catch { return undefined; }
}

export function observeReaderIndent(probe: HTMLElement, changed: (width: number | undefined) => void): () => void {
  let live = true, reported = false, previous: number | undefined;
  const measure = () => {
    if (!live) return;
    const width = measureReaderIndent(probe);
    if (reported && (width === previous || width !== undefined && previous !== undefined && Math.abs(width - previous) < 0.001)) return;
    previous = width; reported = true; changed(width);
  };
  let observer: ResizeObserver | undefined;
  try {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure); observer.observe(probe);
    }
  } catch { try { observer?.disconnect(); } catch { /* Retain the font/resize fallback. */ } observer = undefined; }
  const fonts = probe.ownerDocument.fonts, view = probe.ownerDocument.defaultView;
  fonts?.addEventListener('loadingdone', measure);
  fonts?.addEventListener('loadingerror', measure);
  void fonts?.ready.then(measure, measure);
  view?.addEventListener('resize', measure);
  // Call synchronously from useLayoutEffect so the first visible layout and
  // explicit typography changes never wait for ResizeObserver's next delivery.
  measure();
  return () => {
    if (!live) return;
    live = false;
    try { observer?.disconnect(); } catch { /* Cleanup must still remove listeners. */ }
    fonts?.removeEventListener('loadingdone', measure);
    fonts?.removeEventListener('loadingerror', measure);
    view?.removeEventListener('resize', measure);
  };
}
