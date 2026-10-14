// Passkey sign up and sign in on browsers without PublicKeyCredential.toJSON (Safari before 18.4), against the live site.
// Usage: node scripts/passkey-compat.mjs [manage url]   (NATIVE=1 keeps toJSON, like current browsers)
import { chromium } from "file:///C:/Users/LENOVO/tifo/node_modules/playwright/index.mjs";
const URL = process.argv[2] ?? "https://tifo.vercel.app/manage";
const b = await chromium.launch();
for (const mode of ["register", "login"]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  // Like Safari before it had toJSON on passkey credentials.
  if (!process.env.NATIVE) await ctx.addInitScript(() => { try { delete PublicKeyCredential.prototype.toJSON; } catch {} });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await p.waitForTimeout(5000);
  console.log("toJSON present:", await p.evaluate(() => typeof PublicKeyCredential.prototype.toJSON));
  await p.getByRole("button", { name: /Create my wallet/ }).click();
  let r = await Promise.race([
    p.getByText("What are you selling?").waitFor({ timeout: 60000 }).then(() => "wallet created"),
    p.locator(".err").first().waitFor({ timeout: 60000 }).then(async () => "ERROR: " + (await p.locator(".err").first().innerText())),
  ]).catch((e) => "timeout " + String(e).slice(0, 60));
  if (mode === "login" && r === "wallet created") {
    // Sign out and back in with the same passkey: the sign in path sends the credential too.
    await p.evaluate(() => localStorage.clear());
    await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.waitForTimeout(5000);
    await p.getByRole("button", { name: /I already have one/ }).click();
    r = "login: " + (await Promise.race([
      p.getByText("What are you selling?").waitFor({ timeout: 60000 }).then(() => "signed in"),
      p.locator(".err").first().waitFor({ timeout: 60000 }).then(async () => "ERROR: " + (await p.locator(".err").first().innerText())),
    ]).catch((e) => "timeout " + String(e).slice(0, 60)));
  }
  console.log(mode, "->", r);
  await ctx.close();
}
await b.close();
