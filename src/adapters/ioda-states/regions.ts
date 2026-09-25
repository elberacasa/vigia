/**
 * IODA region ids for Venezuela → ISO 3166-2 codes used by src/geo. IODA geolocates IP space with NetAcuity and
 * names regions after Natural Earth admin-1 (so La Guaira is still "Vargas"). 4481 ("Invalid Region") and 4881
 * ("Unknown Region in Venezuela") are IODA's own buckets for unlocatable space and are not states.
 * Source: /v2/entities/query?entityType=region&relatedTo=country/VE, verified 2026-09-24.
 */
export type IodaRegion = {
	readonly id: string;
	/** IODA's name, kept to match responses. */
	readonly iodaName: string;
	readonly iso: string;
};

export const IODA_REGIONS: readonly IodaRegion[] = [
	{ id: "4482", iodaName: "Falcón", iso: "VE-I" },
	{ id: "4483", iodaName: "Apure", iso: "VE-C" },
	{ id: "4484", iodaName: "Barinas", iso: "VE-E" },
	{ id: "4485", iodaName: "Mérida", iso: "VE-L" },
	{ id: "4486", iodaName: "Táchira", iso: "VE-S" },
	{ id: "4487", iodaName: "Trujillo", iso: "VE-T" },
	{ id: "4488", iodaName: "Zulia", iso: "VE-V" },
	{ id: "4489", iodaName: "Cojedes", iso: "VE-H" },
	{ id: "4490", iodaName: "Carabobo", iso: "VE-G" },
	{ id: "4491", iodaName: "Lara", iso: "VE-K" },
	{ id: "4492", iodaName: "Portuguesa", iso: "VE-P" },
	{ id: "4493", iodaName: "Yaracuy", iso: "VE-U" },
	{ id: "4494", iodaName: "Amazonas", iso: "VE-Z" },
	{ id: "4495", iodaName: "Bolívar", iso: "VE-F" },
	{ id: "4496", iodaName: "Anzoátegui", iso: "VE-B" },
	{ id: "4497", iodaName: "Aragua", iso: "VE-D" },
	{ id: "4498", iodaName: "Vargas", iso: "VE-X" },
	{ id: "4499", iodaName: "Distrito Capital", iso: "VE-A" },
	{ id: "4500", iodaName: "Dependencias Federales", iso: "VE-W" },
	{ id: "4501", iodaName: "Guárico", iso: "VE-J" },
	{ id: "4502", iodaName: "Monagas", iso: "VE-N" },
	{ id: "4503", iodaName: "Miranda", iso: "VE-M" },
	{ id: "4504", iodaName: "Nueva Esparta", iso: "VE-O" },
	{ id: "4505", iodaName: "Sucre", iso: "VE-R" },
	{ id: "4506", iodaName: "Delta Amacuro", iso: "VE-Y" },
];

const BY_ID = new Map(IODA_REGIONS.map((r) => [r.id, r]));
const BY_ISO = new Map(IODA_REGIONS.map((r) => [r.iso, r]));

export function regionById(id: string): IodaRegion | undefined {
	return BY_ID.get(id);
}

export function regionByIso(iso: string): IodaRegion | undefined {
	return BY_ISO.get(iso);
}
