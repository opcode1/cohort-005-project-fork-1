import { describe, expect, it } from "vitest";
import { hasCatalogueTag, isPushEligible } from "./notification-catalogue";

describe("telling which Notification a feed item came from", () => {
  it("finds a feed item tagged with a workflow slug", () => {
    expect(hasCatalogueTag(["seat-claimed"])).toBe(true);
  });

  it("misses a feed item whose template was never tagged", () => {
    expect(hasCatalogueTag([])).toBe(false);
    expect(hasCatalogueTag(undefined)).toBe(false);
    expect(hasCatalogueTag(["urgent"])).toBe(false);
  });

  it("counts only a push Notification's tag as push-eligible", () => {
    expect(isPushEligible(["reply-posted"])).toBe(true);
    expect(isPushEligible(["seat-claimed"])).toBe(false);
    expect(isPushEligible(["urgent"])).toBe(false);
  });
});
