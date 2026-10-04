"use client";
import { useState } from "react";
import type { SmartAccount } from "viem/account-abstraction";
import { saveShopWithCircle } from "@/lib/circleWallet";
import type { Product, Shop, ShopProfile } from "@/lib/shops";
import ImageUpload from "./ImageUpload";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
const newId = () => Math.random().toString(36).slice(2, 8);

export default function ShopEditor({ account, shop, onSaved }: { account: SmartAccount; shop: Shop | null; onSaved: () => void }) {
  const [handle, setHandle] = useState(shop?.handle ?? "");
  const [p, setP] = useState<ShopProfile>(shop?.profile ?? { name: "", products: [{ id: newId(), name: "", priceUsd: 0 }], links: {}, teams: [] });
  const [teamsText, setTeamsText] = useState((shop?.profile.teams ?? []).join(", "));
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "ok" | "err"; text?: string }>({ kind: "idle" });
  const set = (patch: Partial<ShopProfile>) => setP((x) => ({ ...x, ...patch }));
  const setLink = (k: keyof NonNullable<ShopProfile["links"]>, v: string) => setP((x) => ({ ...x, links: { ...x.links, [k]: v } }));
  const setProduct = (i: number, patch: Partial<Product>) => setP((x) => ({ ...x, products: x.products.map((pr, j) => (j === i ? { ...pr, ...patch } : pr)) }));

  async function save() {
    const h = handle || slugify(p.name);
    const products = p.products.filter((x) => x.name.trim() && x.priceUsd > 0);
    if (!p.name.trim()) return setStatus({ kind: "err", text: "Give your shop a name." });
    if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(h)) return setStatus({ kind: "err", text: "Your link needs 3 to 24 lowercase letters, numbers or dashes." });
    if (!products.length) return setStatus({ kind: "err", text: "Add at least one product with a name and a price." });
    const teams = teamsText.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8);
    const clean: ShopProfile = JSON.parse(JSON.stringify({ ...p, teams, products }, (_k, v) => (v === "" ? undefined : v)));
    setStatus({ kind: "working", text: "Confirm with your fingerprint to publish your page…" });
    try {
      await saveShopWithCircle(account, h, clean);
      setHandle(h);
      setStatus({ kind: "ok", text: "Saved. Your page is live." });
      onSaved();
    } catch (e) {
      const m = (e as Error).message;
      setStatus({ kind: "err", text: /HandleTaken/.test(m) ? "That link is taken. Try another." : m.split("\n")[0] });
    }
  }

  return (
    <div className="editor">
      <div className="panel editor">
        <h3>Your shop</h3>
        <div className="grid2">
          <label className="field">
            Shop name
            <input value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Ada's Kits" />
          </label>
          <label className="field">
            Your link <small>tifo.vercel.app/s/{handle || slugify(p.name) || "your-shop"}</small>
            <input value={handle} maxLength={24} onChange={(e) => setHandle(slugify(e.target.value))} placeholder={slugify(p.name) || "your-shop"} />
          </label>
        </div>
        <label className="field">
          One line about what you sell
          <input value={p.tagline ?? ""} maxLength={120} onChange={(e) => set({ tagline: e.target.value })} placeholder="Retro jerseys and matchday scarves, shipped across Lagos" />
        </label>
        <label className="field">
          About <small>optional</small>
          <textarea value={p.bio ?? ""} maxLength={800} onChange={(e) => set({ bio: e.target.value })} />
        </label>
        <div className="grid2">
          <label className="field">
            City <small>optional</small>
            <input value={p.city ?? ""} maxLength={40} onChange={(e) => set({ city: e.target.value })} placeholder="Lagos" />
          </label>
          <label className="field">
            Clubs your buyers follow <small>comma separated, the manager uses this</small>
            <input value={teamsText} onChange={(e) => setTeamsText(e.target.value)} placeholder="Arsenal, Chelsea, Super Eagles" />
          </label>
        </div>
        <div className="grid2">
          <div className="field" style={{ display: "grid", gap: 6, fontWeight: 600, fontSize: ".86rem" }}>
            Logo
            <ImageUpload value={p.logo} onChange={(logo) => set({ logo })} label="logo" />
          </div>
          <div className="field" style={{ display: "grid", gap: 6, fontWeight: 600, fontSize: ".86rem" }}>
            Cover photo
            <ImageUpload value={p.cover} onChange={(cover) => set({ cover })} label="cover" wide />
          </div>
        </div>
        <label className="field" style={{ maxWidth: 220 }}>
          Brand colour
          <input type="color" value={p.color ?? "#5b3cf5"} onChange={(e) => set({ color: e.target.value })} style={{ height: 46, padding: 4 }} />
        </label>
      </div>

      <div className="panel editor">
        <h3>Where buyers reach you</h3>
        <div className="grid2">
          <label className="field">
            WhatsApp number <small>buyers send delivery details here</small>
            <input value={p.links?.whatsapp ?? ""} onChange={(e) => setLink("whatsapp", e.target.value)} placeholder="+234 803 000 0000" inputMode="tel" />
          </label>
          <label className="field">
            Instagram
            <input value={p.links?.instagram ?? ""} onChange={(e) => setLink("instagram", e.target.value)} placeholder="@yourshop" />
          </label>
          <label className="field">
            TikTok
            <input value={p.links?.tiktok ?? ""} onChange={(e) => setLink("tiktok", e.target.value)} placeholder="@yourshop" />
          </label>
          <label className="field">
            X
            <input value={p.links?.x ?? ""} onChange={(e) => setLink("x", e.target.value)} placeholder="@yourshop" />
          </label>
          <label className="field">
            Website
            <input value={p.links?.website ?? ""} onChange={(e) => setLink("website", e.target.value)} placeholder="yourshop.com" />
          </label>
        </div>
      </div>

      <div className="panel editor">
        <h3>
          Products{" "}
          <button className="btn sm ghost" onClick={() => setP((x) => ({ ...x, products: [...x.products, { id: newId(), name: "", priceUsd: 0 }] }))}>
            Add product
          </button>
        </h3>
        {p.products.map((x, i) => (
          <div key={x.id} className="prodedit">
            <ImageUpload value={x.image} onChange={(image) => setProduct(i, { image })}>
              <div className="prev">{x.image ? <img src={x.image} alt="" /> : "Add photo"}</div>
            </ImageUpload>
            <div className="fields">
              <input className="input" value={x.name} maxLength={80} onChange={(e) => setProduct(i, { name: e.target.value })} placeholder="Product name" />
              <input
                className="input"
                type="number"
                min={1}
                step="0.01"
                value={x.priceUsd || ""}
                onChange={(e) => setProduct(i, { priceUsd: Number(e.target.value) })}
                placeholder="Price $"
              />
              <input className="input full" value={x.description ?? ""} maxLength={200} onChange={(e) => setProduct(i, { description: e.target.value })} placeholder="Short description (optional)" />
            </div>
            <button className="x" aria-label="Remove product" onClick={() => setP((y) => ({ ...y, products: y.products.filter((_, j) => j !== i) }))}>
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="savebar">
        <span className={`status ${status.kind === "err" ? "err" : status.kind === "ok" ? "ok" : ""}`} style={{ margin: 0 }}>
          {status.text ?? "Your page is saved on Arc. Only your wallet can change it. No gas fees."}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {shop && (
            <a className="btn sm ghost" href={`/s/${shop.handle}`} target="_blank" rel="noreferrer">
              View page
            </a>
          )}
          <button className="btn sm" onClick={save} disabled={status.kind === "working"}>
            {shop ? "Save changes" : "Create my shop"}
          </button>
        </div>
      </div>
    </div>
  );
}
