"use client";
// Instagram, Facebook, Telegram, TikTok and some others open links in their own built-in browser. iPhones (and some
// Android builds) do not allow passkeys there, so Face ID / fingerprint fails at once. Detect it and send the buyer to
// the real browser instead of showing a confusing error.
export type InApp = { name: string; ios: boolean } | null;

export function inAppBrowser(): InApp {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  const w = window as unknown as { TelegramWebviewProxy?: unknown; TelegramWebview?: unknown };
  const ios = /iPhone|iPad|iPod/.test(ua);
  if (w.TelegramWebviewProxy || w.TelegramWebview || /Telegram/i.test(ua)) return { name: "Telegram", ios };
  if (/Instagram/i.test(ua)) return { name: "Instagram", ios };
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return { name: "Facebook", ios };
  if (/musical_ly|TikTok|BytedanceWebview/i.test(ua)) return { name: "TikTok", ios };
  if (/Snapchat/i.test(ua)) return { name: "Snapchat", ios };
  if (/LinkedInApp/i.test(ua)) return { name: "LinkedIn", ios };
  if (/Line\//i.test(ua)) return { name: "LINE", ios };
  return null;
}

/** A link that leaves the in-app browser for Safari (iOS) or Chrome (Android), when the phone supports it. */
export function openOutside(url = typeof location === "undefined" ? "" : location.href): string {
  if (typeof navigator === "undefined") return url;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return url.replace(/^https:\/\//, "x-safari-https://");
  if (/Android/i.test(navigator.userAgent)) {
    const u = new URL(url);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  }
  return url;
}
