/** Tiny DOM helpers. Everything goes in with textContent / attributes; no HTML is ever parsed from text here. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const NS = "http://www.w3.org/2000/svg";

export function svg(viewBox: string, cls: string, inner: Array<[string, Record<string, string>]>): SVGSVGElement {
  const root = document.createElementNS(NS, "svg");
  root.setAttribute("viewBox", viewBox);
  root.setAttribute("class", cls);
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  for (const [tag, attrs] of inner) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    root.appendChild(n);
  }
  return root;
}

/**
 * The OmniChat logo mark (bubble ring from media/src/icon.svg) as a monochrome icon: the ring is currentColor and the
 * inner `</>` glyph is cut out with the colour `--oc-logo-cut` (set it to the background behind the icon).
 */
export function logoMark(cls = "oc-logo"): SVGSVGElement {
  const root = svg("120 120 800 800", cls, [
    ["path", { class: "oc-logo__ring", fill: "currentColor", "fill-rule": "evenodd", d: "M464 852 A352 352 0 1 1 801.5 600 C770 700 780 800 922 852 Z M464 264 A236 236 0 1 0 464 736 A236 236 0 1 0 464 264 Z" }],
  ]);
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "oc-logo__cut");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke-width", "48");
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  for (const d of ["M392 405 L300 500 L392 595", "M536 405 L628 500 L536 595", "M436 604 L492 396"]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    g.appendChild(p);
  }
  root.appendChild(g);
  return root;
}

/** Square stop icon (currentColor). */
export function stopMark(cls = "oc-stopmark"): SVGSVGElement {
  return svg("0 0 24 24", cls, [["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2.5", fill: "currentColor" }]]);
}
