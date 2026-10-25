import { createContext, useContext } from 'react';
import { t as tr } from './i18n';
import { ARTIFACT_LINE_RE, artifactCloseIndex } from './components/markdownParse';

export type ArtifactType = 'markdown' | 'html' | 'docx' | 'pptx' | 'xlsx' | 'email';

export interface Artifact {
  type: ArtifactType;
  title: string;
  /** Markdown (or HTML for type html) source */
  content: string;
}

/** Parse the fence info string, e.g. `artifact type=docx title="Meeting notes"`. Returns null if it is not an artifact block. */
export function parseArtifactInfo(info: string): { type: ArtifactType; title: string } | null {
  const m = /^\s*artifact(?:\s+(.*))?$/i.exec(info);
  if (!m) return null;
  const rest = m[1] || '';
  const tm = /\btype\s*=\s*"?([A-Za-z]+)"?/.exec(rest);
  const t = (tm?.[1] || 'markdown').toLowerCase();
  const type: ArtifactType = t === 'html' || t === 'docx' || t === 'pptx' || t === 'xlsx' || t === 'email' ? t : 'markdown';
  const nm = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest);
  const title = (nm?.[1] ?? nm?.[2] ?? nm?.[3] ?? '').trim() || tr('art.untitled');
  return { type, title };
}

/** The last complete artifact fenced block in a message text, or null. */
export function lastArtifact(text: string): Artifact | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let found: Artifact | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    let info = parseArtifactInfo(m[2]);
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    // the slip the chat parser handles too: ```excel with the artifact line as its first line
    if (!info && ARTIFACT_LINE_RE.test(lines[j] ?? '')) { info = parseArtifactInfo(lines[j].trim()); j++; }
    if (info) {
      const from = j;
      const e = artifactCloseIndex(lines, from, m[1]);
      closed = e >= 0;
      j = closed ? e : lines.length;
      body.push(...lines.slice(from, j));
    } else {
      for (; j < lines.length; j++) {
        const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
        if (c && c[1][0] === m[1][0] && c[1].length >= m[1].length) { closed = true; break; }
      }
    }
    if (info && closed) found = { ...info, content: body.join('\n') };
    i = j;
  }
  return found;
}

/** True when the artifact has no body text (the model announced a document but wrote nothing). */
export function isEmptyArtifact(content: string): boolean {
  return content.trim() === '';
}

/**
 * Slides counted in a pptx body that is still streaming: lines starting with `# ` or `## `, ignoring lines inside
 * nested code fences (a ```shapes block may contain `#` lines).
 */
export function countPartialSlides(body: string): number {
  let n = 0;
  let fence: string | null = null;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { fence = f[1]; continue; }
    if (/^#{1,2} /.test(line)) n++;
  }
  return n;
}

export interface ArtifactCtx { open: (a: Artifact) => void }
/** Provided by ChatScreen; Markdown cards call `open`. Null outside a chat. */
export const ArtifactContext = createContext<ArtifactCtx | null>(null);
export const useArtifactOpener = () => useContext(ArtifactContext);

export const ARTIFACT_EXT: Record<ArtifactType, string> = { markdown: 'md', html: 'html', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', email: 'eml' };
