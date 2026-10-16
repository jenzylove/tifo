"use client";
import { useState } from "react";
import { copyText } from "@/lib/copy";

/** Share a drop's link from the shop at any time, not only right after posting it. */
export default function ShareDrop({ address, product, className = "btn sm ghost share-drop" }: { address: string; product: string; className?: string }) {
  const [done, setDone] = useState(false);
  async function share(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const url = `${location.origin}/p/${address}`;
    if (navigator.share && /Android|iPhone|iPad|iPod/.test(navigator.userAgent)) {
      try {
        await navigator.share({ title: product, url });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // the person closed the share sheet
      }
    }
    // No share sheet, or it failed: copy instead, and if even that is blocked show the link to copy by hand.
    if (await copyText(url)) {
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } else window.prompt("Copy your drop's link:", url);
  }
  return (
    <button className={className} onClick={share}>
      {done ? "Link copied" : "Copy link"}
    </button>
  );
}
