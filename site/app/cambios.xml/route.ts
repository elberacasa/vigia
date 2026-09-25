import { feedResponse } from "@/lib/feed";

export const dynamic = "force-static";

export function GET() {
	return feedResponse("es");
}
