"use client";

import { useEffect, useRef, useState } from "react";

/** Scroll-reveal for the marketing pages (dependency-free). Falls back to
 * visible when IntersectionObserver is missing (older browsers, jsdom), and
 * respects prefers-reduced-motion via the mk- CSS in MarketingShell. */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`mk-reveal ${shown ? "mk-in" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
