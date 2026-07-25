"use client";
import { createContext, useContext } from "react";

export interface SessionInfo {
  userId: string;
  tenantId: string;
  workspaceId: string;
  scopes: string[];
  /** BRD 70 DSP-FR-014: carried straight through from the session claim
   * (lib/auth/session.ts SessionClaims.profile) — see components/demo/
   * DemoWatermarkBanner.tsx, the one consumer. */
  profile?: string;
}

const Ctx = createContext<SessionInfo | null>(null);

export function SessionProvider({ value, children }: { value: SessionInfo; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionInfo {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession must be used within SessionProvider");
  return s;
}
