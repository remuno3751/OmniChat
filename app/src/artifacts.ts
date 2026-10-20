import { createContext, useContext } from 'react';
import { t as tr } from './i18n';

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
    const info = parseArtifactInfo(m[2]);
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
      if (c && c[1][0] === m[1][0] && c[1].length >= m[1].length) { closed = true; break; }
      body.push(lines[j]);
    }
    if (info && closed) found = { ...info, content: body.join('\n') };
    i = j;
  }
  return found;
}

export interface ArtifactCtx { open: (a: Artifact) => void }
/** Provided by ChatScreen; Markdown cards call `open`. Null outside a chat. */
export const ArtifactContext = createContext<ArtifactCtx | null>(null);
export const useArtifactOpener = () => useContext(ArtifactContext);

export const ARTIFACT_EXT: Record<ArtifactType, string> = { markdown: 'md', html: 'html', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', email: 'eml' };
