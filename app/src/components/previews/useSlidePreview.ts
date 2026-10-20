import { useEffect, useState } from 'react';
import { ApiError, convertPreview } from '../../api';
import type { Slide } from '../../docModel';
import { hasShapesBlock, previewKey } from '../../shapeGeometry';

/*
 * Server preview of a docx / pptx artifact that has ```shapes blocks (the server checks the specs). It waits
 * 400 ms after the last change, so a streaming answer does not ask once per token; results are cached by a hash
 * of the content; an old server (404) is remembered for the session. Without shapes nothing is requested.
 */

const DEBOUNCE_MS = 400;
const CACHE_MAX = 30;
const cache = new Map<string, Slide[]>();
let oldServer = false;

function remember(key: string, slides: Slide[]): void {
  cache.set(key, slides);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

export interface SlidePreview {
  /** the server's slides once fetched (null while loading, or when there are no shapes) */
  slides: Slide[] | null;
  /** the request failed (not an old server) */
  failed: boolean;
  /** the server is too old to draw shapes */
  oldServer: boolean;
}

export function useSlidePreview(content: string, title: string, type: 'docx' | 'pptx'): SlidePreview {
  const wanted = hasShapesBlock(content);
  const key = previewKey(type, title, content);
  const [result, setResult] = useState<{ key: string; failed: boolean } | null>(null);

  useEffect(() => {
    if (!wanted || cache.has(key) || oldServer) return;
    let alive = true;
    const timer = setTimeout(() => {
      convertPreview(content, type, title).then(
        (r) => {
          remember(key, r.slides as Slide[]);
          if (alive) setResult({ key, failed: false });
        },
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) oldServer = true;
          if (alive) setResult({ key, failed: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wanted, key, content, title, type]);

  if (!wanted) return { slides: null, failed: false, oldServer: false };
  const hit = cache.get(key) ?? null;
  return { slides: hit, failed: hit === null && result?.key === key && result.failed, oldServer };
}
