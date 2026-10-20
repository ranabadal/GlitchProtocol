"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getMe, logout, type Me } from "@/lib/client/api";
import { Avatar } from "./Avatar";

/*
 * Top bar shared by the menu pages, plus a hook that loads the signed-in player and
 * sends signed-out visitors to the login screen.
 */

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M4 8 L16 2 L28 8 V22 L16 30 L4 22 Z" fill="none" stroke="#3cff9a" strokeWidth="2" />
      <path d="M10 13 H22 M10 19 H17" stroke="#3cff9a" strokeWidth="2.5" />
      <rect x="19" y="17" width="4" height="4" fill="#ff3d6e" />
    </svg>
  );
}

export function TopBar({ me }: { me?: Me | null }) {
  const path = usePathname();
  const router = useRouter();
  const links = me
    ? [["/hub", "Hub"], ["/leaderboard", "Leaderboard"], ["/profile", "Profile"], ["/rules", "Kaise khelein"]]
    : [["/rules", "Kaise khelein"], ["/login", "Login"], ["/register", "Join"]];
  return (
    <header className="topbar">
      <Link href={me ? "/hub" : "/"} className="logo"><LogoMark /> GLITCH <b>PROTOCOL</b></Link>
      <nav className="nav">
        {links.map(([href, label]) => (
          <Link key={href} href={href} className={path === href ? "active" : ""}>{label}</Link>
        ))}
        {me && (
          <button
            className="btn small red"
            style={{ marginLeft: 6 }}
            onClick={async () => { try { await logout(); } catch { /* ignore */ } router.push("/"); }}
          >Logout</button>
        )}
        {me && <Avatar id={me.user.avatarId} photoUrl={me.user.showPhoto ? me.user.photoUrl : null} size={34} />}
      </nav>
    </header>
  );
}

export function useMe(required = true): { me: Me | null; loading: boolean; error: string | null; reload: () => Promise<void>; setMe: (m: Me) => void } {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setMe(await getMe());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (required) router.replace("/login");
      } else setError(e instanceof Error ? e.message : "Load nahi hua.");
    } finally {
      setLoading(false);
    }
  }, [required, router]);
  useEffect(() => { void reload(); }, [reload]);
  return { me, loading, error, reload, setMe };
}

export function Loading({ text = "Neon City se connect ho rahe hain..." }: { text?: string }) {
  return (
    <div className="row" style={{ justifyContent: "center", padding: 60, gap: 16 }}>
      <div className="spinner" />
      <span className="mono muted">{text}</span>
    </div>
  );
}
