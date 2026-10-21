import { describe, expect, it } from "vitest";
import { formatStatus } from "../src/ui/status";

// Pending approvals (escalation, spec §4.4) show in the status bar; zero leaves the text unchanged.
describe("formatStatus: pending approvals", () => {
  it("is unchanged when nothing is pending", () => {
    expect(formatStatus("online", false)).toEqual({
      text: "$(plug) OmniChat: online",
      tooltip: "OmniChat: online. Click to open OmniChat.",
    });
    expect(formatStatus("online", true).tooltip).toBe("OmniChat: running. Click to open OmniChat.");
  });

  it("shows the count of approvals waiting, singular and plural", () => {
    expect(formatStatus("online", false, undefined, 1).text).toBe("$(plug) OmniChat: online, 1 waiting for approval");
    expect(formatStatus("online", false, undefined, 3).text).toBe("$(plug) OmniChat: online, 3 waiting for approval");
  });

  it("keeps the count visible while running, and puts the detail in the tooltip", () => {
    const view = formatStatus("online", true, undefined, 2);
    expect(view.text).toBe("$(loading~spin) OmniChat: running, 2 waiting for approval");
    expect(formatStatus("offline", false, "timeout", 1).tooltip).toBe("OmniChat: offline, 1 waiting for approval (timeout)");
  });
});
