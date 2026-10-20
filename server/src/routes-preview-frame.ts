import type { FastifyInstance } from "fastify";

/* The page the Code preview iframe loads (web client). A srcdoc / blob iframe inherits the embedding app's Content-Security-Policy,
   which forbids inline scripts, so the previewed page's JavaScript would never run. This route answers with its OWN policy instead:
   - `sandbox allow-scripts` (no allow-same-origin): the framed page gets an opaque origin, so it cannot read the app's storage or DOM;
   - strict mode: no network at all (default-src 'none'; data: images only), so generated JavaScript cannot send anything out;
   - external mode (the user switched "allow external libraries" on): https only.
   The page itself is empty; the client sends the assembled HTML with postMessage and the page writes it into itself. */

const BASE = "sandbox allow-scripts; default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
export const PREVIEW_FRAME_CSP_STRICT = `${BASE}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:`;
export const PREVIEW_FRAME_CSP_EXTERNAL = `${BASE}; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: https:; connect-src https:`;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>preview</title>
<body>
<script>
// refuse to run unless the response's CSP sandbox is in force (opaque origin: document.cookie throws)
var sandboxed = false;
try { void document.cookie; } catch (err) { sandboxed = true; }
if (sandboxed) window.addEventListener('message', function (e) {
  if (e.source !== parent) return;
  var d = e.data;
  if (!d || d.type !== 'omnichat-preview' || typeof d.html !== 'string') return;
  document.open();
  document.write(d.html);
  document.close();
});
if (sandboxed) parent.postMessage({ type: 'omnichat-preview-ready' }, '*');
</script>
</body>
`;

export function registerPreviewFrameRoute(app: FastifyInstance): void {
  // no auth: the page holds no data (the HTML to show is posted by the client)
  app.get("/preview-frame", async (req, reply) => {
    const external = (req.query as { mode?: string } | undefined)?.mode === "external";
    reply
      .header("Content-Security-Policy", external ? PREVIEW_FRAME_CSP_EXTERNAL : PREVIEW_FRAME_CSP_STRICT)
      .header("X-Omnichat-Frameable", "1") // read (and removed) by the global onSend hook: no X-Frame-Options on this page
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8");
    return PAGE;
  });
}
