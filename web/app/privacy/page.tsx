export const metadata = { title: "Privacy · Tifo" };

export default function Privacy() {
  return (
    <section className="wrap section" style={{ maxWidth: 720 }}>
      <h1>Privacy</h1>
      <p>Tifo is a tool for small shops to run match day promos and get paid in USDC on Arc.</p>
      <h3>What we keep</h3>
      <p>
        If you sign in with Google, we receive your name and email from Google to create your Circle wallet. We do not see your Google password and
        we do not post anything for you. Drops, orders and payouts are public on the Arc blockchain, linked to wallet addresses, not names.
      </p>
      <p>
        Delivery addresses that buyers enter are encrypted so only the seller of that drop can read them. Contact details a seller adds to a drop
        (WhatsApp number or Instagram handle) are shown on the drop page.
      </p>
      <h3>Who else handles it</h3>
      <p>Wallets are provided by Circle. The site runs on Vercel. We do not sell your data or use it for ads.</p>
      <h3>Deleting it</h3>
      <p>Ask us to remove your off-chain data (delivery details, shop name) at any time. Records on the blockchain cannot be deleted by anyone.</p>
    </section>
  );
}
