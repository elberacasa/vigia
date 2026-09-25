/** Poll intervals and budgets in words: "cada 10 min", "40 min". */
export function every(ms: number, l: "es" | "en"): string {
	if (ms < 3_600_000)
		return l === "es" ? `cada ${Math.round(ms / 60_000)} min` : `every ${Math.round(ms / 60_000)} min`;
	if (ms < 86_400_000)
		return l === "es" ? `cada ${Math.round(ms / 3_600_000)} h` : `every ${Math.round(ms / 3_600_000)} h`;
	return l === "es" ? `cada ${Math.round(ms / 86_400_000)} d` : `every ${Math.round(ms / 86_400_000)} d`;
}

export function span(ms: number, l: "es" | "en"): string {
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
	return l === "es" ? `${Math.round(ms / 86_400_000)} d` : `${Math.round(ms / 86_400_000)} d`;
}
