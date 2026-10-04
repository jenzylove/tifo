"use client";
import { useRef, useState } from "react";

/** Upload an image (or paste a link). Calls onChange with the hosted URL. */
export default function ImageUpload({ value, onChange, label, wide, children }: { value?: string; onChange: (url: string) => void; label?: string; wide?: boolean; children?: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function pick(f: File) {
    setBusy(true);
    setErr("");
    try {
      const body = new FormData();
      body.append("file", f);
      const r = await fetch("/api/upload", { method: "POST", body });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      onChange(j.url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />;
  if (children)
    return (
      <span onClick={() => ref.current?.click()} title={err || "Upload a photo"}>
        {input}
        {busy ? <span className="fine">Uploading…</span> : children}
      </span>
    );
  return (
    <div className="upl">
      {input}
      <div className={`prev ${wide ? "wide" : ""}`}>{value ? <img src={value} alt="" /> : "No image"}</div>
      <div style={{ display: "grid", gap: 4 }}>
        <button type="button" className="btn sm ghost" onClick={() => ref.current?.click()} disabled={busy}>
          {busy ? "Uploading…" : value ? `Change ${label ?? "image"}` : `Upload ${label ?? "image"}`}
        </button>
        {value && (
          <button type="button" className="link" onClick={() => onChange("")}>
            Remove
          </button>
        )}
        {err && <span className="status err">{err}</span>}
      </div>
    </div>
  );
}
