"use client";
import { useEffect } from "react";
import { useMe } from "@/lib/graphql/hooks";
import { applyBrandingTokens } from "@/lib/branding/apply";

/**
 * Shared embed-surface behavior for every `/embed/*` page:
 *  - applies the host-requested theme (`?theme=light|dark`) to <html>;
 *  - applies the tenant's brand color tokens (BRD 59 WS3) so charts/buttons
 *    inside the iframe match the embedding partner's palette -- embed pages
 *    are headless/chrome-less by design (no sidebar/topbar), so there is no
 *    logo surface to swap here; only the color tokens apply;
 *  - strips the one-time `?t=` token from the visible URL once the middleware
 *    has moved it into the httpOnly `wr_embed` cookie;
 *  - posts `datacern:ready` and continuous `datacern:resize` (content height)
 *    messages to the host window so the embed SDK can auto-size the iframe.
 *
 * postMessage targets `"*"` for the outbound height/ready signals (they carry
 * no sensitive data — just a type + a number); the SDK validates that inbound
 * messages come from the Datacern iframe origin. Inbound host→embed messages
 * (theme changes) are accepted only from the document referrer's origin.
 */
export function useEmbedFrame(): void {
  // The embed session's own JWT (wr_embed cookie) is tenant-scoped, so this
  // resolves to the SAME tenant the iframe's data queries are already scoped
  // to -- no separate embed-branding endpoint needed.
  const me = useMe();
  useEffect(() => {
    applyBrandingTokens(me.data?.me.branding);
  }, [me.data]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // 1) theme
    const params = new URLSearchParams(window.location.search);
    const theme = params.get("theme");
    if (theme === "dark") document.documentElement.classList.add("dark");
    else if (theme === "light") document.documentElement.classList.remove("dark");

    // 2) strip the one-time token from the URL
    if (params.has("t")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("t");
      window.history.replaceState({}, "", url.toString());
    }

    // 3) ready + resize signalling to the host
    const post = (type: string, extra: Record<string, unknown> = {}) => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: "datacern-embed", type, ...extra }, "*");
      }
    };
    post("datacern:ready");
    const emitHeight = () =>
      post("datacern:resize", { height: document.documentElement.scrollHeight });
    emitHeight();
    const ro = new ResizeObserver(emitHeight);
    ro.observe(document.documentElement);

    // 4) accept theme changes from the host (referrer origin only)
    let hostOrigin = "";
    try {
      hostOrigin = document.referrer ? new URL(document.referrer).origin : "";
    } catch {
      hostOrigin = "";
    }
    const onMessage = (e: MessageEvent) => {
      if (hostOrigin && e.origin !== hostOrigin) return;
      const data = e.data as { source?: string; type?: string; theme?: string } | null;
      if (data?.source !== "datacern-host") return;
      if (data.type === "datacern:set-theme") {
        document.documentElement.classList.toggle("dark", data.theme === "dark");
        emitHeight();
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      ro.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
