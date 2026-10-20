// OmniChat example plugin: no permissions, no network. Runs IN-PROCESS with the server's OS permissions.
export const tools = {
  async current_time(args, ctx) {
    const now = new Date();
    let timeZone;
    if (typeof args?.timezone === "string" && args.timezone.trim()) {
      timeZone = args.timezone.trim();
      try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { throw new Error(`unknown time zone "${timeZone}"`); }
    }
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, dateStyle: "full", timeStyle: "long", hourCycle: "h23",
    }).format(now);
    ctx.log(`current_time ${zone}`);
    return { iso: now.toISOString(), timeZone: zone, local, epochMs: now.getTime() };
  },
};
