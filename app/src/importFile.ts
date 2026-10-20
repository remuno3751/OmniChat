// Imports a local file (picked on web) through the server's POST /artifacts/import and returns the artifact it made.
import { getServerUrl, getToken } from './api';
import type { Artifact, ArtifactType } from './artifacts';

export const IMPORT_MAX_BYTES = 5_000_000;
export const IMPORT_ACCEPT = '.docx,.xlsx,.pptx,.eml,.md,.markdown,.txt,.csv';

/** The message is an i18n key (art.openTooLarge, art.openUnsupported or art.openFailed). */
export class ImportError extends Error {}

/** Base64 of raw bytes, encoded in chunks so large files do not exceed the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

const TYPES: ArtifactType[] = ['markdown', 'html', 'docx', 'pptx', 'xlsx', 'email'];

export async function importFileToArtifact(file: File): Promise<Artifact> {
  if (file.size > IMPORT_MAX_BYTES) throw new ImportError('art.openTooLarge');
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));

  let res: Response;
  try {
    res = await fetch(`${getServerUrl()}/artifacts/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
      body: JSON.stringify({ filename: file.name, data }),
    });
  } catch {
    throw new ImportError('art.openFailed');
  }
  if (!res.ok) {
    throw new ImportError(res.status === 413 ? 'art.openTooLarge' : res.status === 415 ? 'art.openUnsupported' : 'art.openFailed');
  }

  let body: any;
  try { body = await res.json(); } catch { throw new ImportError('art.openFailed'); }
  if (!body || !TYPES.includes(body.type) || typeof body.title !== 'string' || typeof body.content !== 'string') {
    throw new ImportError('art.openFailed');
  }
  return { type: body.type, title: body.title, content: body.content };
}
