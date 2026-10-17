"use client";
// What the sales manager does, as one dark panel that holds still while you scroll through it.
// Each duty opens in turn as you move down the page, so the list reads one thing at a time.
import { useEffect, useRef, useState } from "react";

const ITEMS: [string, string][] = [
  ["Plans your promos", "It reads what you sell and how your past drops went, picks a big match, the share back that fits your margin and whether to run referrals, and tells you why. You post it or change it."],
  ["Keeps your cost capped", "You see the most a promo can cost before it goes live, and a contract holds the money, not the AI, so it can never go over that figure."],
  ["Pays fans back and pays you", "After the match it checks the result against independent sources, pays fans of the winning club back by itself and sends you the rest. After every sale it sends your share to your wallet."],
  ["Keeps your books", "Every dollar in and out is written down with the reason: sales, refunds, payouts and what each promo brought in against what it cost."],
  ["Handles delivery and referrals", "Buyers add their address after paying and you see it next to each order; their payment waits until they have it. Buyers who bring friends get their order free, paid for by the extra sales."],
  ["Runs by itself, if you let it", "Give it a weekly limit and it runs your next promos for you. Anything bigger, it asks first. It can never take money out for itself."],
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
            <p>An agent for your shop, starting with match day sales. Every decision it makes is written down where you can check it.</p>
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
