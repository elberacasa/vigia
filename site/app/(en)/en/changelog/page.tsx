import { ChangelogPage } from "@/components/ChangelogPage";
import { Shell } from "@/components/Shell";
import { metadata as meta } from "@/lib/meta";

export const metadata = meta("en", "changelog");

export default function Page() {
	return (
		<Shell lang="en" page="changelog">
			<ChangelogPage lang="en" />
		</Shell>
	);
}
