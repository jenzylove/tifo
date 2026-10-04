// Testnet only: give the test seller wallet a shop page, so the storefront and drop pages can be checked end to end.
// Usage: npx tsx scripts/seed-shop-testnet.mts   (reads SELLER_PK from the environment)
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoShopsAbi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";

const SHOPS = (process.env.SHOPS ?? "0x30444d0006e530cc76418275A421E2665828666d") as Hex;
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const seller = createWalletClient({ account: privateKeyToAccount(process.env.SELLER_PK as Hex), chain: arcTestnet, transport: http() });
const profile = {
  name: "Tifo Test Kits",
  tagline: "A test shop on Arc testnet. Scarves and tees for matchday.",
  bio: "This shop exists so the Tifo team can test drops end to end on testnet. Nothing here ships.",
  city: "Lagos",
  color: "#0f7b5f",
  teams: ["United States", "Mexico", "Arsenal", "Chelsea"],
  links: { website: "tifo.vercel.app" },
  products: [
    { id: "scarf", name: "Rivalry scarf", priceUsd: 1, description: "Two-tone knit scarf, one club each end." },
    { id: "tee", name: "Matchday tee", priceUsd: 2, description: "Heavy cotton tee with the fixture printed on the back." },
  ],
};
const hash = await seller.writeContract({ address: SHOPS, abi: tifoShopsAbi, functionName: "save", args: ["tifo-test-kits", JSON.stringify(profile)] });
await pub.waitForTransactionReceipt({ hash });
console.log("saved", hash);
