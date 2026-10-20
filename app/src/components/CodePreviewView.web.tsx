import React, { useEffect, useMemo, useRef } from 'react';
import { getServerUrl } from '../api';

/**
 * Web preview: a sandboxed iframe, never "allow-same-origin" (the page cannot reach the app's storage or DOM).
 *
 * With JavaScript on, the frame loads the server's /preview-frame page, which answers with its own Content-Security-Policy
 * (a srcdoc frame would inherit the app's policy, which forbids inline scripts: the previewed page's JavaScript would not
 * run). The assembled HTML is posted to that page, which writes it into itself. Without JavaScript a plain srcdoc frame
 * with an empty sandbox is enough.
 */
let frameSeq = 0;

function CodePreviewView({ html, runScripts, allowExternal }: { html: string; runScripts: boolean; allowExternal?: boolean }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const htmlRef = useRef(html);
  htmlRef.current = html;
  // a new frame for every new document (the frame page can write itself only once)
  const version = useMemo(() => ++frameSeq, [html, runScripts, allowExternal]); // eslint-disable-line react-hooks/exhaustive-deps
  const src = `${getServerUrl()}/preview-frame${allowExternal ? '?mode=external' : ''}`;

  useEffect(() => {
    if (!runScripts) return undefined;
    const onMessage = (e: MessageEvent) => {
      const w = ref.current?.contentWindow;
      if (!w || e.source !== w) return;
      const d = e.data as { type?: string } | null;
      if (d && d.type === 'omnichat-preview-ready') w.postMessage({ type: 'omnichat-preview', html: htmlRef.current }, '*');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [runScripts, version]);

  if (!runScripts) {
    return React.createElement('iframe', {
      title: 'preview',
      srcDoc: html,
      sandbox: '',
      referrerPolicy: 'no-referrer',
      style: { border: 0, width: '100%', height: '100%', background: '#fff' },
    });
  }
  return React.createElement('iframe', {
    key: version,
    ref,
    title: 'preview',
    src,
    // no sandbox attribute on purpose: the page's own CSP header sandboxes it (opaque origin) and the page refuses to run otherwise
    referrerPolicy: 'no-referrer',
    style: { border: 0, width: '100%', height: '100%', background: '#fff' },
  });
}

export default React.memo(CodePreviewView);
