/**
 * The TV channels in "En vivo": only each broadcaster's OWN YouTube channel, verified on 2026-09-24 by a link in
 * at least one direction between the broadcaster's website and the channel (noted per channel), plus the
 * channel's id, name and description. No re-streams, no fan channels, no individuals.
 *
 * Who owns or funds each one is part of the card: state media is labelled as such (VTV, teleSUR, and the
 * foreign public broadcasters), so a viewer knows whose voice they are hearing.
 */

export type Ownership =
	/** Privately owned. */
	| "private"
	/** Owned by the Venezuelan state. */
	| "state"
	/** A multi-state channel funded mainly by the Venezuelan state. */
	| "state-funded"
	/** A foreign public-service broadcaster (statutory funding, editorial independence by law). */
	| "public-foreign"
	/** Funded by a foreign government. */
	| "government-foreign";

export type TvChannel = {
	/** Stable slug; the series is `yt:<id>`. */
	readonly id: string;
	readonly name: string;
	/** YouTube channel id (UC…), the only identifier that never changes. */
	readonly channelId: string;
	/** The broadcaster's own website. */
	readonly homepage: string;
	/** Where the broadcaster is based (ISO 3166-1 alpha-2). */
	readonly country: string;
	readonly lang: "es";
	readonly ownership: Ownership;
	/** Short label for the card, e.g. "Estatal (Venezuela)". */
	readonly labelEs: string;
	readonly labelEn: string;
	/** How the channel was verified as the broadcaster's own (2026-09-24). */
	readonly verified: string;
};

export const TV_CHANNELS: readonly TvChannel[] = [
	{
		id: "vpitv",
		name: "VPItv",
		channelId: "UCVFiIRuxJ2GmJLUkHmlmj4w",
		homepage: "https://vpitv.com/",
		country: "VE",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · Venezuela",
		labelEn: "Private · Venezuela",
		verified: "vpitv.com enlaza youtube.com/c/vpitvenvivo; canal verificado por YouTube",
	},
	{
		id: "evtv",
		name: "EVTV Miami",
		channelId: "UCshe7-1A5MN_ArHsG_3V41g",
		homepage: "https://evtvmiami.com/",
		country: "US",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · Miami (diáspora)",
		labelEn: "Private · Miami (diaspora)",
		verified: "el canal enlaza evtvmiami.com (el sitio no resolvió desde este equipo)",
	},
	{
		id: "ntn24",
		name: "NTN24",
		channelId: "UCEJs1fTF3KszRJGxJY14VrA",
		homepage: "https://www.ntn24.com/",
		country: "CO",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · Colombia",
		labelEn: "Private · Colombia",
		verified: "ntn24.com enlaza youtube.com/@ntn24; canal verificado por YouTube",
	},
	{
		id: "globovision",
		name: "Globovisión",
		channelId: "UC0nGYg5JpX7tIeQw_-DQTLw",
		homepage: "https://globovision.com/",
		country: "VE",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · Venezuela",
		labelEn: "Private · Venezuela",
		verified: "globovision.com enlaza @GlobovisiónenVivoTV/live y el canal enlaza globovision.com",
	},
	{
		id: "venevision",
		name: "Noticias Venevisión",
		channelId: "UCR1tLg8fy9dklmhZPf0qCWQ",
		homepage: "https://www.venevision.com/",
		country: "VE",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · Venezuela",
		labelEn: "Private · Venezuela",
		verified: "venevision.com enlaza @NoticieroVenevision y el canal enlaza venevision.com",
	},
	{
		id: "televen",
		name: "Televen",
		channelId: "UCPxs1siPSF6YKGtKP_Zyvtw",
		homepage: "https://televen.com/",
		country: "VE",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · Venezuela",
		labelEn: "Private · Venezuela",
		verified: "televen.com enlaza @TelevenTV y el canal enlaza televen.com",
	},
	{
		id: "vtv",
		name: "VTV (Venezolana de Televisión)",
		channelId: "UC_8sCVycu3FXidPNoZwOHqA",
		homepage: "https://vtv.com.ve/",
		country: "VE",
		lang: "es",
		ownership: "state",
		labelEs: "Medio estatal · Venezuela",
		labelEn: "State media · Venezuela",
		verified: "vtv.com.ve enlaza @VTV-canal8 e inserta su transmisión; el canal enlaza vtv.com.ve",
	},
	{
		id: "telesur",
		name: "teleSUR",
		channelId: "UCZSdNK_ZmMQcLTz-obKr-Dw",
		homepage: "https://www.telesurtv.net/",
		country: "VE",
		lang: "es",
		ownership: "state-funded",
		labelEs: "Financiado por el Estado venezolano",
		labelEn: "Funded by the Venezuelan state",
		verified: "telesurtv.net enlaza @envivotelesur",
	},
	{
		id: "cnnee",
		name: "CNN en Español",
		channelId: "UC_lEiu6917IJz03TnntWUaQ",
		homepage: "https://cnnespanol.cnn.com/",
		country: "US",
		lang: "es",
		ownership: "private",
		labelEs: "Privado · EE. UU.",
		labelEn: "Private · US",
		verified: "cnnespanol.cnn.com enlaza el canal por su id; canal verificado por YouTube",
	},
	{
		id: "dw",
		name: "DW Español",
		channelId: "UCT4Jg8h03dD0iN3Pb5L0PMA",
		homepage: "https://www.dw.com/es/",
		country: "DE",
		lang: "es",
		ownership: "public-foreign",
		labelEs: "Servicio público · Alemania",
		labelEn: "Public broadcaster · Germany",
		verified: "dw.com/es enlaza youtube.com/DeutscheWelleEspanol (→ @dwespanol); canal verificado",
	},
	{
		id: "france24",
		name: "France 24 Español",
		channelId: "UCUdOoVWuWmgo1wByzcsyKDQ",
		homepage: "https://www.france24.com/es/",
		country: "FR",
		lang: "es",
		ownership: "public-foreign",
		labelEs: "Servicio público · Francia",
		labelEn: "Public broadcaster · France",
		verified: "france24.com/es enlaza el canal por su id; canal verificado por YouTube",
	},
	{
		id: "voa",
		name: "Voz de América",
		channelId: "UCJ46VgZgCMLFUvOT671AOJw",
		homepage: "https://www.vozdeamerica.com/",
		country: "US",
		lang: "es",
		ownership: "government-foreign",
		labelEs: "Financiado por el Gobierno de EE. UU.",
		labelEn: "Funded by the US government",
		verified: "vozdeamerica.com enlaza youtube.com/user/vozdeamerica; canal verificado por YouTube",
	},
];
