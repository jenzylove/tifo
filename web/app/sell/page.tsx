import SellerChat from "@/components/SellerChat";

export default function Sell() {
  return (
    <section className="page">
      <h1>Your sales rep</h1>
      <p className="lede">Tell it what you sell. It picks a match your buyers care about, prices both sides from live odds, and caps what you can ever owe.</p>
      <SellerChat />
    </section>
  );
}
