import { HttpError, json, requireUser, route, loadUser } from "@/lib/http";
import { deletePhoto, MAX_PHOTO_BYTES, mePayload, savePhoto } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_PHOTO_BYTES + 64 * 1024) throw new HttpError(413, "TOO_LARGE", "Photo 3 MB se chhoti honi chahiye.");
  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get("photo");
  } catch {
    throw new HttpError(400, "NO_FILE", "Upload karne ke liye photo chuno.");
  }
  if (!file || typeof file === "string") throw new HttpError(400, "NO_FILE", "Upload karne ke liye photo chuno.");
  await savePhoto(user, Buffer.from(await file.arrayBuffer()));
  return json({ ok: true, ...(await mePayload(await loadUser(user.id))) });
});

export const DELETE = route(async (req) => {
  const user = await requireUser(req);
  await deletePhoto(user);
  return json({ ok: true, ...(await mePayload(await loadUser(user.id))) });
});
