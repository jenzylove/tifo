import type { Metadata } from "next";
import Manager from "@/components/manage/Manager";

export const metadata: Metadata = { title: "Your drops · Tifo" };

export default function ManagePage() {
  return <Manager />;
}
