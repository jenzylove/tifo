// Walks the live site the way a seller and a buyer would, signing with a virtual passkey, and saves a
// screenshot of every screen. Passkeys are bound to the site's domain, so this runs against the live site.
// Usage: node --env-file=web/.env.development.local scripts/qa-live.mjs <out_dir>
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.env.TIFO_URL ?? "https://tifo.vercel.app";
const out = process.argv[2] ?? "qa";
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errors = [];

async function person(browser, viewport, name) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, colorScheme: "light", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${String(e).slice(0, 200)}`));
  // Circle's wallet service answers over JSON-RPC; keep any refusal it gives, with the call that caused it.
  page.on("response", async (r) => {
    if (!r.url().includes("modular-sdk.circle.com")) return;
    try {
      if (process.env.QA_TRACE) {
        const q = JSON.parse(r.request().postData() ?? "{}");
        for (const x of Array.isArray(q) ? q : [q]) {
          const op = x.method === "eth_sendUserOperation" || x.method === "eth_estimateUserOperationGas" ? x.params?.[0] : null;
          console.log("  circle", x.method, op ? `paymaster=${op.paymaster ?? "none"} callGas=${op.callGasLimit} verGas=${op.verificationGasLimit} preVer=${op.preVerificationGas} factory=${op.factory ? "yes" : "no"}` : "");
        }
      }
      const body = await r.json();
      if (process.env.QA_TRACE) for (const b of Array.isArray(body) ? body : [body]) if (b?.result && typeof b.result === "object" && ("paymaster" in b.result || "sponsor" in b.result)) console.log("  circle paymaster answer", JSON.stringify(b.result).slice(0, 300));
      for (const b of Array.isArray(body) ? body : [body]) {
        if (!b?.error) continue;
        const req = JSON.parse(r.request().postData() ?? "{}");
        const method = (Array.isArray(req) ? req.find((x) => x.id === b.id) : req)?.method;
        errors.push(`${name}: circle ${method} -> ${JSON.stringify(b.error).slice(0, 500)}`);
      }
    } catch {
      // not JSON, nothing to record
    }
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const shot = (file, full = false) => page.screenshot({ path: `${out}/${file}.png`, fullPage: full });
  return { page, shot };
}

const browser = await chromium.launch();
try {
  // ---------- public pages
  const visitor = await person(browser, { width: 1440, height: 900 }, "visitor");
  for (const [path, file] of [["/", "01-home"], ["/drops", "02-drops"], ["/proof", "03-proof"]]) {
    await visitor.page.goto(URL + path, { waitUntil: "networkidle" });
    await visitor.page.waitForTimeout(path === "/" ? 5200 : 900);
    await visitor.shot(file);
  }
  await visitor.page.goto(URL + "/", { waitUntil: "networkidle" });
  await visitor.page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 180)); } });
  await visitor.page.waitForTimeout(600);
  await visitor.shot("01-home-full", true);

  // ---------- seller: sign in, make a drop, turn on autopilot
  const seller = await person(browser, { width: 1440, height: 900 }, "seller");
  await seller.page.goto(URL + "/manage", { waitUntil: "networkidle" });
  await seller.shot("10-seller-signin");
  await seller.page.getByRole("button", { name: /Create my wallet/ }).click();
  await seller.page.getByText("New match drop").waitFor({ timeout: 90_000 });
  log("seller signed in");
  await seller.page.getByPlaceholder("Glow", { exact: true }).fill(process.env.QA_NAME ?? "Glow Studio");
  await seller.page.getByPlaceholder("Gua sha").fill(process.env.QA_PRODUCT ?? "Budget planner kit");
  const nums = seller.page.locator('.maker input[type="number"]');
  await nums.nth(0).fill("5");
  await seller.page.getByPlaceholder(/Paste the download link/).fill("https://example.com/budget-planner-kit.zip");
  await seller.page.locator(".pick").first().waitFor({ timeout: 60_000 });
  await seller.page.waitForTimeout(700);
  await seller.shot("11-seller-form", true);
  await seller.page.getByRole("button", { name: /Get my link/ }).click();
  // Either the drop goes live, or the form says why not. Record whichever happens.
  await Promise.race([
    seller.page.getByText("Your drop is live.").waitFor({ timeout: 150_000 }),
    seller.page.locator(".launch .status.err").waitFor({ timeout: 150_000 }).then(async () => {
      await seller.shot("12-seller-error", true);
      throw new Error(`the form refused: ${await seller.page.locator(".launch .status.err").innerText()}`);
    }),
  ]).catch(async (e) => {
    await seller.shot("12-seller-stuck", true);
    const status = await seller.page.locator(".launch .status").allInnerTexts().catch(() => []);
    throw new Error(`${String(e).slice(0, 200)} | status on screen: ${status.join(" / ") || "none"}`);
  });
  await seller.page.waitForTimeout(900);
  await seller.shot("12-seller-live");
  const dropUrl = (await seller.page.locator(".done code").first().innerText()).trim();
  log("drop", dropUrl);
  if (process.env.QA_STOP_AFTER_DROP) throw new Error("STOP: drop made, stopping as asked");
  await seller.page.getByRole("button", { name: "Overview" }).click();
  await seller.page.waitForTimeout(6000);
  await seller.shot("13-seller-overview", true);
  await seller.page.getByRole("button", { name: "Autopilot" }).click();
  await seller.page.waitForTimeout(600);
  await seller.shot("14-autopilot-off");
  await seller.page.getByRole("button", { name: "Turn on autopilot" }).click();
  await seller.page.getByText("Left this week").waitFor({ timeout: 120_000 });
  await seller.page.waitForTimeout(9000);
  await seller.shot("15-autopilot-on", true);
  log("autopilot on");
  await seller.page.getByRole("button", { name: "Money" }).click();
  await seller.page.waitForTimeout(1200);
  await seller.shot("16-seller-money");

  // ---------- buyer on a phone: open the link, make a wallet, get funded, buy, open the purchase
  const buyer = await person(browser, { width: 390, height: 844 }, "buyer");
  await buyer.page.goto(dropUrl, { waitUntil: "networkidle" });
  await buyer.page.waitForTimeout(900);
  await buyer.shot("20-drop-phone", true);
  await buyer.page.getByRole("button", { name: /Create a wallet/ }).click();
  await buyer.page.getByText("Paying from").waitFor({ timeout: 90_000 });
  await buyer.page.waitForTimeout(1200);
  await buyer.shot("21-drop-phone-needs-funds", true);
  await buyer.page.getByRole("button", { name: /Copy my wallet address/ }).click();
  const address = (await buyer.page.evaluate(() => navigator.clipboard.readText())).trim();
  log("buyer wallet", address);
  execFileSync("cast", ["send", "0x3600000000000000000000000000000000000000", "transfer(address,uint256)", address, "5500000", "--private-key", process.env.BACKUP_SELLER_PK, "--rpc-url", "https://rpc.testnet.arc.io"], { stdio: "ignore" });
  await buyer.page.getByText("$5.50").waitFor({ timeout: 60_000 });
  await buyer.page.locator(".offer").first().click();
  await buyer.page.waitForTimeout(500);
  await buyer.shot("22-drop-phone-ready", true);
  await buyer.page.getByRole("button", { name: /Buy for/ }).click();
  await buyer.page.getByText("Order paid.").waitFor({ timeout: 120_000 });
  await buyer.page.getByText(/Here is your/).waitFor({ timeout: 60_000 });
  await buyer.page.waitForTimeout(800);
  await buyer.shot("23-drop-phone-paid", true);
  log("buyer paid and opened the purchase");

  // ---------- the same drop on a desktop after an order
  await visitor.page.goto(dropUrl, { waitUntil: "networkidle" });
  await visitor.page.waitForTimeout(900);
  await visitor.shot("24-drop-desktop", true);
} catch (e) {
  errors.push(`FLOW STOPPED: ${String(e).slice(0, 400)}`);
} finally {
  await browser.close();
}
console.log(errors.length ? `PROBLEMS:\n${errors.join("\n")}` : "no errors");
