import { describe, expect, it } from "vitest";
import { everydayNames } from "./results";

// TheSportsDB only finds a match by the clubs' everyday names. These official names come from real Europa League
// fixtures where the search used to find nothing, so the agent had to wait for a second source.
describe("everyday club names for the result search", () => {
  const first = (n: string) => everydayNames(n)[0];
  it.each([
    ["Sport Lisboa e Benfica", "Benfica"],
    ["Olympiakós SFP", "Olympiacos"],
    ["SK Puntigamer Sturm Graz", "Sturm Graz"],
    ["Beşiktaş JK", "Besiktas"],
    ["GNK Dinamo Zagreb", "Dinamo Zagreb"],
    ["RSC Anderlecht", "Anderlecht"],
    ["Olympique de Marseille", "Marseille"],
    ["RC Celta de Vigo", "Celta Vigo"],
    ["Manchester City FC", "Manchester City"],
  ])("%s -> %s", (official, everyday) => {
    expect(first(official)).toBe(everyday);
  });
  it("never names a club by a word many clubs share", () => {
    expect(everydayNames("West Ham United FC")).not.toContain("United");
    expect(everydayNames("Brighton and Hove Albion")).not.toContain("Albion");
  });
  it("keeps names it does not know", () => {
    expect(everydayNames("TSG 1899 Hoffenheim")).toContain("Hoffenheim");
    expect(everydayNames("Juventus FC")).toContain("Juventus");
  });
});
