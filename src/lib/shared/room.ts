/** Colours and names shared by the lobby, the in-game scoreboard and the name tags above racers. */
export const TEAM_COLORS: Record<"A" | "B", string> = { A: "#29d9ff", B: "#ff4fd8" };
export const TEAM_NAMES: Record<"A" | "B", string> = { A: "Team A", B: "Team B" };

/** Distinct colours for solo racers, in join order. */
export const RACER_COLORS = ["#3cff9a", "#ffb229", "#29d9ff", "#ff4fd8"];

export function racerColor(team: "A" | "B" | null, index: number): string {
  return team ? TEAM_COLORS[team] : RACER_COLORS[index % RACER_COLORS.length];
}
