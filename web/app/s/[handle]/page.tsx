import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DropCard from "@/components/DropCard";
import { dropCards } from "@/lib/board";
import { shortTeam } from "@/lib/matches";
import { shopByHandle, socialLinks, whatsappLink } from "@/lib/shops";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const shop = await shopByHandle(handle).catch(() => null);
  if (!shop) return { title: "Tifo" };
  return { title: `${shop.profile.name} · Tifo`, description: shop.profile.tagline ?? shop.profile.bio?.slice(0, 150) };
}

export default async function Storefront({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const shop = await shopByHandle(handle).catch(() => null);
  if (!shop) notFound();
  const p = shop.profile;
  const drops = await dropCards((s) => s === shop.owner.toLowerCase(), 50);
  const live = drops.filter((d) => d.phase === "open");
  const past = drops.filter((d) => d.phase !== "open");
  const liveFor = (id: string) => live.find((d) => d.p.meta.productId === id);
  const links = socialLinks(p);
  const order = (name: string) => (p.links?.whatsapp ? whatsappLink(p.links.whatsapp, `Hi ${p.name}, I'd like to order: ${name}`) : links[0]?.href);

  return (
    <div style={{ ["--brand" as string]: p.color || undefined }}>
      <div className="wrap" style={{ padding: 0 }}>
        <div className="cover">{p.cover && <img src={p.cover} alt="" />}</div>
      </div>
      <div className="wrap">
        <div className="shophead">
          <div className="logo">{p.logo ? <img src={p.logo} alt="" /> : p.name.slice(0, 1)}</div>
          <div>
            <h1>{p.name}</h1>
            {p.tagline && <p className="tag">{p.tagline}</p>}
          </div>
          <div className="links">
            {links.map((l) => (
              <a key={l.label} className={`btn sm ${l.label === "WhatsApp" ? "" : "ghost"}`} href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ))}
          </div>
        </div>
        <div className="shopmeta">
          {p.city && <span className="pill">{p.city}</span>}
          {(p.teams ?? []).map((t) => (
            <span key={t} className="pill ac">{t} fans</span>
          ))}
          {live.length > 0 && <span className="pill live">{live.length} match {live.length === 1 ? "drop" : "drops"} on now</span>}
        </div>

        {live.length > 0 && (
          <>
            <h2 className="h">
              Match drops <small>buy now, get money back if your team wins</small>
            </h2>
            <div className="drops">
              {live.map((c) => (
                <DropCard key={c.p.address} {...c} />
              ))}
            </div>
          </>
        )}

        <h2 className="h">
          Products <small>{p.products.length} items</small>
        </h2>
        {p.products.length === 0 ? (
          <p className="empty panel">No products yet.</p>
        ) : (
          <div className="products">
            {p.products.map((x) => {
              const d = liveFor(x.id);
              return (
                <div key={x.id} className="pcard">
                  <div className="ph">
                    {x.image ? <img src={x.image} alt={x.name} /> : <span className="ph-name">{x.name}</span>}
                    {d && <span className="pill live">Match drop</span>}
                  </div>
                  <div className="body">
                    <h3>{x.name}</h3>
                    {x.description && <p className="fine">{x.description}</p>}
                    <div className="row">
                      <span className="price">${x.priceUsd.toFixed(2)}</span>
                      {d ? (
                        <a className="btn sm" href={`/p/${d.p.address}`}>
                          Up to {Math.max(...d.rates) / 100}% back
                        </a>
                      ) : order(x.name) ? (
                        <a className="btn sm ghost" href={order(x.name)} target="_blank" rel="noreferrer">
                          Order
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(p.bio || past.length > 0) && (
          <div className="about" style={{ marginTop: 52 }}>
            {p.bio && (
              <div className="panel">
                <h3>About {p.name}</h3>
                <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{p.bio}</p>
              </div>
            )}
            {past.length > 0 && (
              <div className="panel">
                <h3>Past drops</h3>
                {past.slice(0, 5).map((c) => (
                  <a key={c.p.address} href={`/p/${c.p.address}`} className="mini-row" style={{ textDecoration: "none" }}>
                    <span>
                      {c.p.meta.product} · {shortTeam(c.p.meta.teamA)} v {shortTeam(c.p.meta.teamB)}
                    </span>
                    <span className="fine">{c.note ?? `${c.fans} orders`}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
