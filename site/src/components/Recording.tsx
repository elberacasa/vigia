"use client";

import { useEffect, useRef, useState } from "react";
import { type Lang, tr } from "@/lib/i18n";

export interface Chapter {
	at: number;
	es: string;
	en: string;
}

/**
 * The screen recording: poster first, the video file only fetched when the frame nears the screen. It plays by
 * itself (muted, looping) on a wide screen with a mouse; on a phone, on a slow connection, with Save-Data or reduced
 * motion, the poster stays until the reader taps play (the video is 0.8–1 MB). It can always be paused.
 */
export function Recording({
	lang,
	chapters,
	label,
	poster,
	sources,
}: {
	lang: Lang;
	chapters: readonly Chapter[];
	label: string;
	poster: string;
	sources: { webm: string; mp4: string };
}) {
	// The big play button over the poster repeats the small one (which keyboards and screen readers use).
	const t = tr(lang);
	const video = useRef<HTMLVideoElement>(null);
	const [loaded, setLoaded] = useState(false);
	const [near, setNear] = useState(false);
	const [playing, setPlaying] = useState(false);
	const [time, setTime] = useState(0);

	useEffect(() => {
		const v = video.current;
		if (!v) return;
		const connection = (
			navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
		).connection;
		const quiet =
			matchMedia("(prefers-reduced-motion: reduce), (max-width: 767px), (pointer: coarse)").matches ||
			Boolean(connection?.saveData) ||
			(connection?.effectiveType !== undefined && connection.effectiveType !== "4g");
		const io = new IntersectionObserver(
			([e]) => {
				if (!e) return;
				if (e.isIntersecting) {
					setNear(true);
					if (!quiet) {
						setLoaded(true);
						void v.play().catch(() => {});
					}
				} else if (!v.paused) v.pause();
			},
			{ rootMargin: "400px 0px", threshold: 0 },
		);
		io.observe(v);
		return () => io.disconnect();
	}, []);

	const toggle = () => {
		const v = video.current;
		if (!v) return;
		setLoaded(true);
		if (v.paused) void v.play().catch(() => {});
		else v.pause();
	};
	const seek = (at: number) => {
		const v = video.current;
		if (!v) return;
		setLoaded(true);
		v.currentTime = at;
		void v.play().catch(() => {});
	};
	const current = [...chapters].reverse().find((c) => time >= c.at - 0.05);

	return (
		<div>
			<div className="frame relative">
				<div
					className="flex h-9 items-center gap-2 border-b border-line bg-surface-1 px-4"
					aria-hidden="true"
				>
					<span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
					<span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
					<span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
					<span className="data mx-auto rounded-md bg-surface-2 px-3 py-0.5 text-[0.6875rem] text-text-3">
						localhost:7722
					</span>
				</div>
				<video
					ref={video}
					className="block aspect-[16/10] w-full bg-surface-0"
					muted
					loop
					playsInline
					preload="none"
					poster={near ? poster : undefined}
					aria-label={label}
					onPlay={() => setPlaying(true)}
					onPause={() => setPlaying(false)}
					onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
					onClick={toggle}
				>
					{loaded ? (
						<>
							<source src={sources.webm} type="video/webm" />
							<source src={sources.mp4} type="video/mp4" />
						</>
					) : null}
				</video>
				{!playing && time === 0 ? (
					<button
						type="button"
						onClick={toggle}
						tabIndex={-1}
						aria-hidden="true"
						className="absolute left-1/2 top-[calc(50%+1.125rem)] grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line-strong bg-bg/80 text-text shadow-lg backdrop-blur transition-colors hover:bg-surface-2"
					>
						<svg width="22" height="22" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
							<path d="M3.5 1.8v10.4L12 7z" />
						</svg>
					</button>
				) : null}
				<button
					type="button"
					onClick={toggle}
					className="absolute bottom-3 right-3 grid h-10 w-10 place-items-center rounded-full border border-line-strong bg-bg/70 text-text backdrop-blur transition-colors hover:bg-surface-2"
					aria-label={
						playing
							? t("Pausar la grabación", "Pause the recording")
							: t("Reproducir la grabación", "Play the recording")
					}
				>
					<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
						{playing ? <path d="M3 2h3v10H3zM8 2h3v10H8z" /> : <path d="M3.5 1.8v10.4L12 7z" />}
					</svg>
				</button>
			</div>
			<ol className="mt-4 flex flex-wrap gap-2" aria-label={t("Capítulos", "Chapters")}>
				{chapters.map((c) => {
					const on = current === c && (playing || time > 0);
					return (
						<li key={c.at}>
							<button
								type="button"
								onClick={() => seek(c.at)}
								aria-current={on ? "true" : undefined}
								className={`chip transition-colors hover:border-line-strong hover:text-text ${on ? "!border-signal/60 !text-text" : ""}`}
							>
								<span className="data text-[0.6875rem] text-text-3">
									0:{String(Math.floor(c.at)).padStart(2, "0")}
								</span>
								{lang === "es" ? c.es : c.en}
							</button>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
