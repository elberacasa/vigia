import { Shell } from "@/components/Shell";
import { SourcesPage } from "@/components/SourcesPage";
import { metadata as meta } from "@/lib/meta";

export const metadata = meta("en", "sources");

export default function Page() {
	return (
		<Shell lang="en" page="sources">
			<SourcesPage lang="en" />
		</Shell>
	);
}
