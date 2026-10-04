"use client";
import type { Dispatch, SetStateAction } from "react";
import { NeedsTap, walletError } from "./circleWallet";

export type Retry = null | (() => Promise<void>);

/** If the phone needs a fresh tap to open Face ID, keep the prepared action behind a "Confirm" button. */
export function handleTap<T>(e: unknown, finish: (r: T) => void, fail: (msg: string) => void, setRetry: Dispatch<SetStateAction<Retry>>): boolean {
  if (!(e instanceof NeedsTap)) return false;
  const go = (e as NeedsTap<T>).go;
  setRetry(() => async () => {
    setRetry(null);
    try {
      finish(await go());
    } catch (err) {
      fail(walletError(err));
    }
  });
  return true;
}
