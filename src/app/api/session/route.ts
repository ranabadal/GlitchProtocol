import { json, optionalUser, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Cheap signed-in check for the welcome screen (never 401s). */
export const GET = route(async (req) => {
  const user = await optionalUser(req);
  return json(user ? { signedIn: true, nickname: user.nickname } : { signedIn: false });
});
