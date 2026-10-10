"use client";
// Fades its children up as they scroll into view. Without JavaScript the content is simply visible.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

export default function Reveal({ children, delay = 0, className = "", as: Tag = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "section" | "li" }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.classList.add("in");
          io.disconnect();
        }
      },
      { threshold: 0.16 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} className={`rv ${className}`} style={{ ["--d" as string]: `${delay}s` } as CSSProperties}>
      {children}
    </Tag>
  );
}
