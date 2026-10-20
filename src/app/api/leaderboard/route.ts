import { json, requireUser, route } from "@/lib/http";
import { BANDS, type Band } from "@/lib/engine/types";
import { bandBoard, eventBoard, listEvents, overallBoard } from "@/lib/services/leaderboard";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const board = url.searchParams.get("board") ?? "overall";
  const events = await listEvents();
  if (board === "band") {
    const band = Number(url.searchParams.get("band") ?? "1") as Band;
    const b = BANDS.includes(band) ? band : 1;
    return json({ board, band: b, rows: await bandBoard(user.id, b), events });
  }
  if (board === "event") {
    const ev = events.find((e) => e.id === url.searchParams.get("eventId")) ?? events[0];
    return json({ board, event: ev ?? null, rows: ev ? await eventBoard(user.id, ev.id) : [], events });
  }
  return json({ board: "overall", rows: await overallBoard(user.id), events });
});
