// Which Arc Onramp environment this deployment talks to. The widget origin must match on server and client.
export const ONRAMP_SANDBOX = process.env.NEXT_PUBLIC_ONRAMP_SANDBOX === "1";
export const ONRAMP_WIDGET = ONRAMP_SANDBOX ? "https://onramp-sandbox.arc.io" : "https://onramp.arc.io";

/** Plain words for why a card or bank payment did not go through. null means close quietly. */
export function onrampReason(code: string, message?: string): string | null {
  switch (code) {
    case "CANCELED_BY_CUSTOMER":
      return null;
    case "CUSTOMER_REJECTED":
      return "The identity check did not pass. Your name, date of birth, address and ID number must match your documents exactly. You can also pay with USDC from an exchange.";
    case "CUSTOMER_PENDING_REVIEW":
      return "Your identity check is still being reviewed. Try again later, or pay with USDC from an exchange.";
    case "NO_PAYMENT_OPTIONS":
      return "Card and bank payments are not available in your country yet. Pay with USDC from an exchange instead.";
    case "SESSION_TIMEOUT":
      return "This payment window timed out. Open it again to continue.";
    case "PAYMENT_PROVIDER_ERROR":
      return message ? `The payment provider stopped this payment: ${message}` : "The payment provider stopped this payment. Nothing was charged.";
    case "PAGE_NOT_LOADED":
      return "The payment window did not load. Check your connection, or open it in a new tab.";
    case "INVALID_SESSION_TOKEN":
      return "The payment session was not accepted. Close this and try again.";
    default:
      return message || "Card payments could not start.";
  }
}

/** iOS Safari limits storage inside iframes, which can break the identity check, so it gets a new tab instead. */
export function prefersWindow(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
  const inApp = /Instagram|FBAN|FBAV|Line\/|LinkedInApp|TikTok|musical_ly|Snapchat|WhatsApp/i.test(ua);
  return ios && !inApp;
}
