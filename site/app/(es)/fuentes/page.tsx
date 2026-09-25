import { Shell } from "@/components/Shell";
import { SourcesPage } from "@/components/SourcesPage";
import { metadata as meta } from "@/lib/meta";

export const metadata = meta("es", "sources");

export default function Page() {
	return (
		<Shell lang="es" page="sources">
			<SourcesPage lang="es" />
		</Shell>
	);
}
