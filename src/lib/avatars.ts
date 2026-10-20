// Shared by the browser and the server. Each avatar is an original operator emblem
// drawn in components/Avatar.tsx; the ids are what we store.
export const AVATARS = [
  { id: "viper", name: "Viper", hue: 140 },
  { id: "ghost", name: "Ghost", hue: 185 },
  { id: "cipher", name: "Cipher", hue: 340 },
  { id: "volt", name: "Volt", hue: 52 },
  { id: "nova", name: "Nova", hue: 280 },
  { id: "rook", name: "Rook", hue: 205 },
  { id: "ember", name: "Ember", hue: 18 },
  { id: "echo", name: "Echo", hue: 100 },
] as const;

export type AvatarId = (typeof AVATARS)[number]["id"];
export const AVATAR_IDS = AVATARS.map((a) => a.id) as AvatarId[];

export function isAvatarId(v: unknown): v is AvatarId {
  return typeof v === "string" && (AVATAR_IDS as string[]).includes(v);
}
