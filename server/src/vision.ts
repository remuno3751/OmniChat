/* Can this model read images? (docs/design/ATTACHMENTS.md "画像が読めるか(ビジョン対応)の判定").
   Order: the user's own override (settings.modelVision), then the metadata the model list gave (ModelEntry.vision), else "unknown". */

export type VisionSupport = "yes" | "no" | "unknown";

/** Reads the vision flag from one raw model-list entry. undefined when the entry says nothing about images. */
export function visionFromMeta(m: unknown): VisionSupport | undefined {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, any>;
  const yn = (b: boolean): VisionSupport => (b ? "yes" : "no");
  const arch = o.architecture?.input_modalities;
  if (Array.isArray(arch)) return yn(arch.includes("image"));
  const mods = o.modalities;
  if (mods && typeof mods === "object" && !Array.isArray(mods) && typeof mods.vision === "boolean") return yn(mods.vision);
  if (Array.isArray(mods)) return yn(mods.includes("image") || mods.includes("vision"));
  if (Array.isArray(o.capabilities)) return yn(o.capabilities.includes("vision"));
  if (typeof o.vision === "boolean") return yn(o.vision);
  if (Array.isArray(o.input)) return yn(o.input.includes("image"));
  if (o.type === "vlm") return "yes";
  return undefined;
}

/** The support for `modelId` on the provider `providerRow`. `overrides` is settings.modelVision (keys "<providerId>::<model>"). */
export function visionSupport(
  providerRow: { id?: string } | null | undefined,
  modelId: string,
  modelEntryMeta?: { vision?: VisionSupport } | null,
  overrides?: Record<string, boolean> | null,
): VisionSupport {
  if (providerRow?.id && overrides) {
    const v = overrides[`${providerRow.id}::${modelId}`];
    if (typeof v === "boolean") return v ? "yes" : "no";
  }
  const meta = modelEntryMeta?.vision;
  return meta === "yes" || meta === "no" ? meta : "unknown";
}
