/**
 * Solar zenith angle (degrees) at a place and time: NOAA's general solar position equations (Spencer 1971
 * series), accurate to a fraction of a degree, which is plenty to say whether a satellite frame shows day or
 * night.
 */
export function solarZenithDeg(latDeg: number, lonDeg: number, at: number): number {
	const date = new Date(at);
	const start = Date.UTC(date.getUTCFullYear(), 0, 1);
	const dayOfYear = Math.floor((at - start) / 86_400_000) + 1;
	const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3_600;
	const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hours - 12) / 24);
	const eqTimeMin =
		229.18 *
		(0.000075 +
			0.001868 * Math.cos(g) -
			0.032077 * Math.sin(g) -
			0.014615 * Math.cos(2 * g) -
			0.040849 * Math.sin(2 * g));
	const decl =
		0.006918 -
		0.399912 * Math.cos(g) +
		0.070257 * Math.sin(g) -
		0.006758 * Math.cos(2 * g) +
		0.000907 * Math.sin(2 * g) -
		0.002697 * Math.cos(3 * g) +
		0.00148 * Math.sin(3 * g);
	const trueSolarMin = hours * 60 + eqTimeMin + 4 * lonDeg;
	const hourAngle = ((trueSolarMin / 4 - 180) * Math.PI) / 180;
	const phi = (latDeg * Math.PI) / 180;
	const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle);
	return (Math.acos(Math.min(1, Math.max(-1, cosZ))) * 180) / Math.PI;
}
