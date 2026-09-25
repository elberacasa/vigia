import type { ReactNode } from "react";
import { Document } from "@/components/Document";
import { metadata as meta, viewport as vp } from "@/lib/meta";

export const metadata = meta("es");
export const viewport = vp;

export default function Layout({ children }: { children: ReactNode }) {
	return <Document lang="es">{children}</Document>;
}
