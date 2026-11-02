import GuestOrderStatus from "@/components/GuestOrderStatus";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your order · Tifo", robots: { index: false } };

// Bachs sends a guest buyer here after paying in naira, with ?checkout_id= added to the address.
export default async function NairaPaid({ searchParams }: { searchParams: Promise<{ checkout_id?: string }> }) {
  const { checkout_id } = await searchParams;
  const ok = typeof checkout_id === "string" && /^chk_[A-Za-z0-9]+$/.test(checkout_id);
  return (
    <div className="wrap" style={{ maxWidth: 520 }}>
      <div className="pagehead">
        <span className="eyebrow">Paid in naira</span>
        <h1>Your order</h1>
      </div>
      {ok ? <GuestOrderStatus checkoutId={checkout_id} /> : <p className="empty panel">This link is incomplete. Open the link from your payment again.</p>}
    </div>
  );
}
