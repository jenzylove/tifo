"use client";
// A booking time shown in the viewer's own timezone. The server does not know that timezone, so the browser fills
// the label in; rendering it on the server would show every buyer the server's clock instead of their own.
import { useEffect, useState } from "react";
import { slotLabel } from "@/lib/booking";

export default function SlotTime({ iso }: { iso: string }) {
  const [label, setLabel] = useState("");
  useEffect(() => setLabel(slotLabel(iso)), [iso]);
  return <>{label || " "}</>;
}
