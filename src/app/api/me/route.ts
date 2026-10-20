import { json, requireUser, route } from "@/lib/http";
import { mePayload } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => json(await mePayload(await requireUser(req))));
