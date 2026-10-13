"use client";
// What the sales manager does, as one dark panel that holds still while you scroll through it.
// Each duty opens in turn as you move down the page, so the list reads one thing at a time.
import { useEffect, useRef, useState } from "react";

const ITEMS: [string, string][] = [
  ["Plans the drop", "It looks at how your past drops went and the big matches coming up, then picks one and the share back that fits your margin. It tells you the most it can cost and what it usually costs before you say yes."],
  ["Keeps your cost capped", "Every buyer gets the same share back if their team wins. Your stock caps the cost, so it can never go over the figure you saw, because a contract holds the money, not the AI."],
  ["Pays the winners", "It checks the result against three sources and pays as soon as two agree. No claim form, no waiting a week."],
  ["Shows you the score", "After every match you see what the drop brought in, what it cost, and whether it paid for itself."],
  ["Runs by itself, if you let it", "Give it a weekly limit and it runs drops for you. Anything bigger than the limit, it has to ask first. It can never take money out."],
];

export default function Duties() {
  const ref = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);

  // How far the page has moved through this section decides which duty is open.
  useEffect(() => {
    const on = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(0.999, Math.max(0, -r.top / span)) : 0;
      setActive(Math.floor(p * ITEMS.length));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, []);

  function jump(i: number) {
    const el = ref.current;
    if (!el) return;
    const span = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: el.offsetTop + (span * (i + 0.2)) / ITEMS.length, behavior: "smooth" });
  }

  return (
    <section ref={ref} className="duties" style={{ height: `calc(100vh + ${ITEMS.length * 48}vh)` }}>
      <div className="duties-stick">
        <div className="duties-panel">
          <header>
            <h2>
              It does the work. You set the <em>limit</em>
            </h2>
            <p>An AI sales manager with a budget it has to earn back. Every decision it makes is written down where you can check it.</p>
          </header>
          <ol>
            {ITEMS.map(([title, text], i) => (
              <li key={title} className={i === active ? "on" : ""} onClick={() => jump(i)}>
                <span className="n">0{i + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <div className="more">
                    <p>{text}</p>
                  </div>
                </div>
                <span className="sign" aria-hidden />
              </li>
            ))}
          </ol>
          <div className="duties-bar" aria-hidden>
            <i style={{ scale: `${(active + 1) / ITEMS.length} 1` }} />
          </div>
        </div>
      </div>
    </section>
  );
}
