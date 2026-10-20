import { HttpError, requireUser, route } from "@/lib/http";
import { readPhotoFor } from "@/lib/services/users";

export const dynamic = "force-dynamic";

// Photos live outside the public folder and are served only through this check.
export const GET = route<{ params: Promise<{ userId: string }> }>(async (req, ctx) => {
  const viewer = await requireUser(req);
  const { userId } = await ctx.params;
  const buf = await readPhotoFor(viewer, userId);
  if (!buf) throw new HttpError(404, "NO_PHOTO", "Koi photo nahi hai.");
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" },
  });
});
