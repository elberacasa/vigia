import { ChangelogPage } from "@/components/ChangelogPage";
import { Shell } from "@/components/Shell";
import { metadata as meta } from "@/lib/meta";

export const metadata = meta("es", "changelog");

export default function Page() {
	return (
		<Shell lang="es" page="changelog">
			<ChangelogPage lang="es" />
		</Shell>
	);
}
