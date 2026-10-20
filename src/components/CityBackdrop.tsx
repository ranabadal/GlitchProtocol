"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/*
 * The living 3D city behind every menu screen: traffic, crowds and NULL's robots on
 * patrol while the camera glides between towers. It is the same engine as the game,
 * in "attract mode" (no player). Hidden on the play screen, which runs its own game.
 */

export function CityBackdrop() {
  const path = usePathname();
  const hidden = path?.startsWith("/play");
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (hidden || !ref.current) return;
    let game: { dispose(): void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const test = document.createElement("canvas").getContext("webgl2");
        if (!test) throw new Error("no webgl2");
        const [{ Game }, { ensureFonts }, { savedQuality }] = await Promise.all([import("@/game/Game"), import("@/game/fonts"), import("@/game/Quality")]);
        await ensureFonts();
        if (cancelled || !ref.current) return;
        // Menus never need more than medium detail.
        const saved = savedQuality();
        game = new Game({ canvas: ref.current, mission: null, attract: true, quality: saved === "high" ? "medium" : saved ?? "auto" });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      game?.dispose();
    };
  }, [hidden]);

  if (hidden) return null;
  if (failed) return <div className="backdrop-fallback" aria-hidden />;
  return (
    <div className="backdrop" aria-hidden>
      <canvas ref={ref} />
    </div>
  );
}
