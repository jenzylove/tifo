"use client";
import { useState } from "react";

/** Share a drop's link from the shop at any time, not only right after posting it. */
export default function ShareDrop({ address, product, className = "btn sm ghost share-drop" }: { address: string; product: string; className?: string }) {
  const [done, setDone] = useState(false);
  async function share(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const url = `${location.origin}/p/${address}`;
    try {
      if (navigator.share && /Android|iPhone|iPad|iPod/.test(navigator.userAgent)) await navigator.share({ title: product, url });
      else await navigator.clipboard.writeText(url);
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch {
      // the share sheet was closed
    }
  }
  return (
    <button className={className} onClick={share}>
      {done ? "Link copied" : "Copy link"}
    </button>
  );
}
