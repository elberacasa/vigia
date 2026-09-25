/**
 * The hero's 2.5D map of Venezuela in WebGL (ogl): the app's own state outlines, raised a little, shaded by the
 * internet level Vigía measured per state, with the week's earthquakes and the day's strongest fires placed where
 * they were. Everything drawn comes from map.json (a snapshot written by scripts/site-data.ts); nothing blinks.
 * Motion: the states rise and the quake rings open once; after that only a slow drift and the pointer move the
 * camera. It renders only while visible.
 */
import earcut from "earcut";
import { Camera, Geometry, Mesh, Program, Renderer, Transform, Vec3 } from "ogl";

export type Level = "normal" | "drop" | "severe" | "no-data";

export interface MapData {
	frame: { width: number; height: number };
	states: { iso: string; name: string; label: [number, number]; rings: number[][] }[];
	neighbours: { name: string; rings: number[][] }[];
	live: {
		capturedAt: number;
		asOf: number;
		connectivity: { asOf: number; states: { iso: string; level: Level }[] };
		quakes: { x: number; y: number; mag: number; at: number; place: string; source: string }[];
		fires: { x: number; y: number; frpMW: number; at: number; place: string }[];
	};
}

export interface Hover {
	kind: "state" | "quake" | "fire";
	index: number;
	/** Pointer position inside the canvas, CSS px. */
	x: number;
	y: number;
}

interface Palette {
	land: [number, number, number];
	side: [number, number, number];
	border: [number, number, number];
	grid: [number, number, number];
	signal: [number, number, number];
	warn: [number, number, number];
	alert: [number, number, number];
	neighbour: [number, number, number];
	dark: boolean;
}

const UNIT = 100; // map px per world unit (one degree of latitude)
const HEIGHT = 0.22;
const DAY = 86_400_000;

function hex(v: string, fallback: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})$/i.exec(v.trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback);
	const n = Number.parseInt(m?.[1] ?? "000000", 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The theme's colours, read from the page's CSS custom properties. */
export function palette(el: Element): Palette {
	const css = getComputedStyle(el);
	const v = (name: string) => css.getPropertyValue(name);
	const bg = hex(v("--bg"), "#07090e");
	const dark = bg[0] + bg[1] + bg[2] < 1.2;
	return {
		land: dark ? hex("#1f2839", "") : hex("#fbf9f5", ""),
		side: dark ? hex("#0c1018", "") : hex("#d9d3c6", ""),
		border: dark ? hex("#465370", "") : hex("#a9a191", ""),
		grid: hex(v("--info"), "#6cb4ff"),
		signal: hex(v("--signal"), "#f6b532"),
		warn: hex(v("--warn"), "#ff9f43"),
		alert: hex(v("--alert"), "#ff5a5f"),
		neighbour: dark ? hex("#2a3242", "") : hex("#c9c2b3", ""),
		dark,
	};
}

// ---------- Geometry ----------

interface Built {
	states: Geometry;
	borders: Geometry;
	neighbours: Geometry;
	quakes: Geometry;
	fires: Geometry;
	centre: [number, number];
	/** Per-state rings in map px, for picking. */
	pick: { rings: number[][]; box: [number, number, number, number] }[];
}

const world = (x: number, y: number, c: [number, number]): [number, number] => [
	(x - c[0]) / UNIT,
	(y - c[1]) / UNIT,
];

function build(gl: Renderer["gl"], data: MapData): Built {
	// Centre on Venezuela's land, not on the frame.
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const pick = data.states.map((s) => {
		const box: [number, number, number, number] = [
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		for (const r of s.rings)
			for (let i = 0; i < r.length; i += 2) {
				const x = r[i] as number;
				const y = r[i + 1] as number;
				box[0] = Math.min(box[0], x);
				box[1] = Math.min(box[1], y);
				box[2] = Math.max(box[2], x);
				box[3] = Math.max(box[3], y);
			}
		minX = Math.min(minX, box[0]);
		minY = Math.min(minY, box[1]);
		maxX = Math.max(maxX, box[2]);
		maxY = Math.max(maxY, box[3]);
		return { rings: s.rings, box };
	});
	const centre: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
	// Caracas (roughly the Distrito Capital label) is where the rise starts.
	const dc = data.states.find((s) => s.iso === "VE-A")?.label ?? centre;
	const levelOf = new Map(data.live.connectivity.states.map((s) => [s.iso, s.level]));
	const levelCode: Record<Level, number> = { normal: 0, drop: 1, severe: 2, "no-data": 3 };

	const pos: number[] = [];
	const nrm: number[] = [];
	const state: number[] = [];
	const top: number[] = [];
	const level: number[] = [];
	const delay: number[] = [];
	const idx: number[] = [];
	const bpos: number[] = [];
	const bdelay: number[] = [];
	data.states.forEach((s, si) => {
		const d = Math.hypot(s.label[0] - dc[0], s.label[1] - dc[1]) / 1400;
		const lv = levelCode[levelOf.get(s.iso) ?? "no-data"];
		for (const ring of s.rings) {
			// Top face.
			const base = pos.length / 3;
			const flat: number[] = [];
			for (let i = 0; i < ring.length; i += 2) {
				const [x, z] = world(ring[i] as number, ring[i + 1] as number, centre);
				flat.push(x, z);
				pos.push(x, 1, z);
				nrm.push(0, 1, 0);
				state.push(si);
				top.push(1);
				level.push(lv);
				delay.push(d);
			}
			for (const t of earcut(flat)) idx.push(base + t);
			// Walls, and the outline along the top edge.
			const n = flat.length / 2;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				const ax = flat[i * 2] as number;
				const az = flat[i * 2 + 1] as number;
				const bx = flat[j * 2] as number;
				const bz = flat[j * 2 + 1] as number;
				const len = Math.hypot(bx - ax, bz - az) || 1;
				const nx = (bz - az) / len;
				const nz = -(bx - ax) / len;
				const w = pos.length / 3;
				pos.push(ax, 0, az, bx, 0, bz, bx, 1, bz, ax, 1, az);
				for (let k = 0; k < 4; k++) {
					nrm.push(nx, 0, nz);
					state.push(si);
					top.push(0);
					level.push(lv);
					delay.push(d);
				}
				idx.push(w, w + 1, w + 2, w, w + 2, w + 3);
				bpos.push(ax, 1, az, bx, 1, bz);
				bdelay.push(d, d);
			}
		}
	});
	const index = pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
	const states = new Geometry(gl, {
		position: { size: 3, data: new Float32Array(pos) },
		normal: { size: 3, data: new Float32Array(nrm) },
		aState: { size: 1, data: new Float32Array(state) },
		aTop: { size: 1, data: new Float32Array(top) },
		aLevel: { size: 1, data: new Float32Array(level) },
		aDelay: { size: 1, data: new Float32Array(delay) },
		index: { data: index },
	});
	const borders = new Geometry(gl, {
		position: { size: 3, data: new Float32Array(bpos) },
		aDelay: { size: 1, data: new Float32Array(bdelay) },
	});

	const npos: number[] = [];
	for (const n of data.neighbours)
		for (const ring of n.rings)
			for (let i = 0; i < ring.length; i += 2) {
				const j = (i + 2) % ring.length;
				const [ax, az] = world(ring[i] as number, ring[i + 1] as number, centre);
				const [bx, bz] = world(ring[j] as number, ring[j + 1] as number, centre);
				npos.push(ax, 0, az, bx, 0, bz);
			}
	const neighbours = new Geometry(gl, { position: { size: 3, data: new Float32Array(npos) } });

	// Earthquakes: a flat ring each (a quad the fragment shader draws a ring on). Size by magnitude; older is fainter.
	const q = data.live.quakes;
	const qpos: number[] = [];
	const qcorner: number[] = [];
	const qsize: number[] = [];
	const qage: number[] = [];
	const qorder: number[] = [];
	const qidx: number[] = [];
	q.forEach((e, i) => {
		const [x, z] = world(e.x, e.y, centre);
		const r = 0.15 + Math.max(0, e.mag - 1.5) * 0.1;
		const age = Math.min(1, Math.max(0, (data.live.capturedAt - e.at) / (7 * DAY)));
		const b = qpos.length / 3;
		for (const [cx, cz] of [
			[-1, -1],
			[1, -1],
			[1, 1],
			[-1, 1],
		] as const) {
			qpos.push(x, 0, z);
			qcorner.push(cx, cz);
			qsize.push(r);
			qage.push(age);
			qorder.push(q.length > 1 ? i / (q.length - 1) : 0);
		}
		qidx.push(b, b + 1, b + 2, b, b + 2, b + 3);
	});
	const quakes = new Geometry(gl, {
		position: { size: 3, data: new Float32Array(qpos) },
		aCorner: { size: 2, data: new Float32Array(qcorner) },
		aSize: { size: 1, data: new Float32Array(qsize) },
		aAge: { size: 1, data: new Float32Array(qage) },
		aOrder: { size: 1, data: new Float32Array(qorder) },
		index: { data: new Uint16Array(qidx) },
	});

	const fpos: number[] = [];
	const fsize: number[] = [];
	for (const f of data.live.fires) {
		const [x, z] = world(f.x, f.y, centre);
		fpos.push(x, 0, z);
		fsize.push(Math.min(1, Math.log10(1 + f.frpMW) / 2.2));
	}
	const fires = new Geometry(gl, {
		position: { size: 3, data: new Float32Array(fpos) },
		aSize: { size: 1, data: new Float32Array(fsize) },
	});
	return { states, borders, neighbours, quakes, fires, centre, pick };
}

// ---------- Shaders ----------

const RISE = /* glsl */ `
uniform float uTime;
float rise(float d) { return smoothstep(0.0, 1.0, clamp((uTime - 0.15 - d * 1.1) / 0.9, 0.0, 1.0)); }
`;

const STATES_VS = /* glsl */ `
attribute vec3 position; attribute vec3 normal; attribute float aState; attribute float aTop; attribute float aLevel; attribute float aDelay;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform float uHeight;
varying vec3 vNormal; varying float vTop; varying float vLevel; varying float vState; varying vec3 vPos;
${RISE}
void main() {
	vec3 p = position; p.y *= uHeight * rise(aDelay);
	vNormal = normal; vTop = aTop; vLevel = aLevel; vState = aState; vPos = p;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const STATES_FS = /* glsl */ `
precision highp float;
uniform vec3 uLand; uniform vec3 uSide; uniform vec3 uWarn; uniform vec3 uAlert; uniform float uHover; uniform float uDark;
varying vec3 vNormal; varying float vTop; varying float vLevel; varying float vState; varying vec3 vPos;
void main() {
	vec3 c = uLand;
	if (vLevel > 0.5 && vLevel < 1.5) c = mix(uLand, uWarn, 0.55);
	else if (vLevel > 1.5 && vLevel < 2.5) c = mix(uLand, uAlert, 0.6);
	else if (vLevel > 2.5) c = mix(uLand, uSide, 0.45);
	vec3 L = normalize(vec3(-0.45, 0.8, -0.35));
	float diff = max(dot(normalize(vNormal), L), 0.0);
	vec3 col = vTop > 0.5 ? c * (0.92 + 0.08 * diff) : mix(uSide, c, 0.3) * (0.78 + 0.3 * diff) * (0.8 + 0.2 * clamp(vPos.y / 0.22, 0.0, 1.0));
	// A soft light from the north-west across the tops (the lookout's side of the map).
	if (vTop > 0.5) col *= 1.0 + (uDark > 0.5 ? 0.18 : 0.04) * clamp(1.0 - length(vPos.xz - vec2(-2.4, -2.6)) / 7.0, 0.0, 1.0);
	if (abs(vState - uHover) < 0.5) col = mix(col, uDark > 0.5 ? vec3(1.0) : vec3(0.0), vTop > 0.5 ? 0.1 : 0.05);
	gl_FragColor = vec4(col, 1.0);
}`;

const LINES_VS = /* glsl */ `
attribute vec3 position; attribute float aDelay;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform float uHeight;
${RISE}
void main() {
	vec3 p = position; p.y = p.y * uHeight * rise(aDelay) + 0.0015;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FLAT_VS = /* glsl */ `
attribute vec3 position;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const COLOR_FS = /* glsl */ `
precision highp float; uniform vec3 uColor; uniform float uAlpha;
void main() { gl_FragColor = vec4(uColor, uAlpha); }`;

const GRID_VS = /* glsl */ `
attribute vec3 position;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
varying vec2 vXZ;
void main() { vXZ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Graticule: one line per degree of latitude and longitude (the map's projection), fading away from the country.
const GRID_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uAlpha; uniform vec2 uOrigin; uniform float uCos;
varying vec2 vXZ;
float line(float v) { return 1.0 - smoothstep(0.012, 0.03, abs(fract(v - 0.5) - 0.5)); }
void main() {
	vec2 px = vXZ * 100.0 + uOrigin;
	float lon = px.x / (100.0 * uCos);
	float lat = px.y / 100.0;
	float g = max(line(lon), line(lat));
	float fade = 1.0 - smoothstep(4.0, 11.0, length(vXZ * vec2(0.9, 1.1)));
	gl_FragColor = vec4(uColor, g * uAlpha * fade);
}`;

const QUAKE_VS = /* glsl */ `
attribute vec3 position; attribute vec2 aCorner; attribute float aSize; attribute float aAge; attribute float aOrder;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform float uHeight; uniform float uTime;
varying vec2 vUv; varying float vAge; varying float vOpen;
void main() {
	vOpen = smoothstep(0.0, 1.0, clamp((uTime - 1.2 - aOrder * 0.9) / 0.7, 0.0, 1.0));
	vUv = aCorner; vAge = aAge;
	vec3 p = position + vec3(aCorner.x, 0.0, aCorner.y) * aSize * (0.25 + 0.75 * vOpen);
	p.y = uHeight + 0.004;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const QUAKE_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying vec2 vUv; varying float vAge; varying float vOpen;
void main() {
	float r = length(vUv);
	float ring = smoothstep(0.72, 0.8, r) * (1.0 - smoothstep(0.9, 0.98, r));
	float core = 1.0 - smoothstep(0.14, 0.24, r);
	float fill = (1.0 - smoothstep(0.0, 0.8, r)) * 0.14;
	float a = max(max(ring, core), fill) * mix(1.0, 0.42, vAge) * vOpen;
	if (a < 0.01) discard;
	gl_FragColor = vec4(uColor, a);
}`;

const FIRE_VS = /* glsl */ `
attribute vec3 position; attribute float aSize;
uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform float uHeight; uniform float uDpr; uniform float uTime;
void main() {
	vec3 p = position; p.y = uHeight + 0.006;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
	gl_PointSize = (4.0 + 5.0 * aSize) * uDpr * clamp((uTime - 1.6) / 0.6, 0.0, 1.0);
}`;

const FIRE_FS = /* glsl */ `
precision highp float; uniform vec3 uColor;
void main() {
	float r = length(gl_PointCoord - 0.5) * 2.0;
	float a = 1.0 - smoothstep(0.55, 1.0, r);
	if (a < 0.01) discard;
	gl_FragColor = vec4(uColor, a * 0.95);
}`;

// ---------- Scene ----------

export interface SceneHandle {
	destroy(): void;
	setPalette(p: Palette): void;
}

export function mount(
	canvasHost: HTMLElement,
	data: MapData,
	opts: { onHover: (h: Hover | null) => void; onReady: () => void; onLost: () => void },
): SceneHandle {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const renderer = new Renderer({ dpr, alpha: true, antialias: true, premultipliedAlpha: false });
	const gl = renderer.gl;
	gl.clearColor(0, 0, 0, 0);
	const canvas = gl.canvas as HTMLCanvasElement;
	canvas.setAttribute("aria-hidden", "true");
	canvas.style.display = "block";
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvasHost.appendChild(canvas);

	const camera = new Camera(gl, { fov: 26, near: 0.1, far: 100 });
	const scene = new Transform();
	const built = build(gl, data);
	let pal = palette(canvasHost);
	const origin = [built.centre[0], built.centre[1]];

	const uTime = { value: 0 };
	const uHeight = { value: HEIGHT };
	const uHover = { value: -1 };
	const statesProgram = new Program(gl, {
		vertex: STATES_VS,
		fragment: STATES_FS,
		uniforms: {
			uTime,
			uHeight,
			uHover,
			uLand: { value: pal.land },
			uSide: { value: pal.side },
			uWarn: { value: pal.warn },
			uAlert: { value: pal.alert },
			uDark: { value: pal.dark ? 1 : 0 },
		},
		cullFace: false,
	});
	const bordersProgram = new Program(gl, {
		vertex: LINES_VS,
		fragment: COLOR_FS,
		uniforms: { uTime, uHeight, uColor: { value: pal.border }, uAlpha: { value: pal.dark ? 0.85 : 0.9 } },
		transparent: true,
		depthWrite: false,
	});
	const neighboursProgram = new Program(gl, {
		vertex: FLAT_VS,
		fragment: COLOR_FS,
		uniforms: { uColor: { value: pal.neighbour }, uAlpha: { value: 0.9 } },
		transparent: true,
		depthWrite: false,
	});
	const gridProgram = new Program(gl, {
		vertex: GRID_VS,
		fragment: GRID_FS,
		uniforms: {
			uColor: { value: pal.grid },
			uAlpha: { value: pal.dark ? 0.28 : 0.3 },
			uOrigin: { value: origin },
			uCos: { value: 0.992546151641322 },
		},
		transparent: true,
		depthWrite: false,
		cullFace: false,
	});
	const quakeProgram = new Program(gl, {
		vertex: QUAKE_VS,
		fragment: QUAKE_FS,
		uniforms: { uTime, uHeight, uColor: { value: pal.signal } },
		transparent: true,
		depthTest: false,
		depthWrite: false,
		cullFace: false,
	});
	const fireProgram = new Program(gl, {
		vertex: FIRE_VS,
		fragment: FIRE_FS,
		uniforms: { uTime, uHeight, uDpr: { value: dpr }, uColor: { value: pal.warn } },
		transparent: true,
		depthTest: false,
		depthWrite: false,
	});

	const gridGeometry = new Geometry(gl, {
		position: {
			size: 3,
			data: new Float32Array([-14, -0.001, -12, 14, -0.001, -12, 14, -0.001, 12, -14, -0.001, 12]),
		},
		index: { data: new Uint16Array([0, 1, 2, 0, 2, 3]) },
	});
	const grid = new Mesh(gl, { geometry: gridGeometry, program: gridProgram });
	const neighbours = new Mesh(gl, { geometry: built.neighbours, program: neighboursProgram, mode: gl.LINES });
	const states = new Mesh(gl, { geometry: built.states, program: statesProgram });
	const borders = new Mesh(gl, { geometry: built.borders, program: bordersProgram, mode: gl.LINES });
	const quakes = new Mesh(gl, { geometry: built.quakes, program: quakeProgram });
	const fires = new Mesh(gl, { geometry: built.fires, program: fireProgram, mode: gl.POINTS });
	grid.renderOrder = 0;
	neighbours.renderOrder = 1;
	states.renderOrder = 2;
	borders.renderOrder = 3;
	quakes.renderOrder = 4;
	fires.renderOrder = 5;
	for (const m of [grid, neighbours, states, borders, quakes, fires]) m.setParent(scene);

	// Camera: from the south, looking down at about 52°, north up. Pointer and a slow drift add a little yaw.
	const target = new Vec3(-0.35, 0, 0.35);
	let yaw = 0;
	let pitch = 0;
	let wantYaw = 0;
	let wantPitch = 0;
	let dist = 24.5;
	const place = (time: number) => {
		const drift = Math.sin(time * 0.07) * 0.05;
		const y = yaw + drift;
		const p = 0.84 + pitch;
		camera.position.set(
			target.x + Math.sin(y) * Math.cos(p) * dist,
			target.y + Math.sin(p) * dist,
			target.z + Math.cos(y) * Math.cos(p) * dist,
		);
		camera.lookAt(target);
	};

	const resize = () => {
		const w = canvasHost.clientWidth;
		const h = canvasHost.clientHeight;
		if (!w || !h) return;
		renderer.setSize(w, h);
		camera.perspective({ aspect: w / h });
		// Fit the country (about 13 by 10 degrees): narrower screens step the camera back.
		const aspect = w / h;
		dist = aspect < 1.3 ? 24.5 + (1.3 - aspect) * 16 : 24.5;
	};
	// A resize redraws once the loop exists (it may be idle).
	const ro = new ResizeObserver(() => {
		resize();
		if (typeof redraw === "function") redraw();
	});
	ro.observe(canvasHost);
	resize();

	let redraw: (() => void) | null = null;

	// Picking on the top plane: pointer ray to y = height, then point-in-polygon in map px.
	const ndcRay = (cx: number, cy: number) => {
		const w = canvasHost.clientWidth;
		const h = canvasHost.clientHeight;
		const near = new Vec3((cx / w) * 2 - 1, 1 - (cy / h) * 2, -1);
		const far = new Vec3(near.x, near.y, 1);
		camera.unproject(near);
		camera.unproject(far);
		const dir = far.sub(near).normalize();
		const t = (HEIGHT - near.y) / dir.y;
		return [near.x + dir.x * t, near.z + dir.z * t] as const;
	};
	const inside = (ring: number[], x: number, y: number) => {
		let hit = false;
		for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
			const xi = ring[i] as number;
			const yi = ring[i + 1] as number;
			const xj = ring[j] as number;
			const yj = ring[j + 1] as number;
			if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
		}
		return hit;
	};
	const project = (x: number, z: number) => {
		const v = new Vec3(x, HEIGHT, z);
		camera.project(v);
		return [((v.x + 1) / 2) * canvasHost.clientWidth, ((1 - v.y) / 2) * canvasHost.clientHeight] as const;
	};
	const hoverAt = (cx: number, cy: number): Hover | null => {
		// Points first (they sit on top): the nearest within 14 px.
		let best: Hover | null = null;
		let bestD = 14;
		const test = (kind: "quake" | "fire", list: readonly { x: number; y: number }[]) => {
			list.forEach((p, i) => {
				const [sx, sy] = project(...world(p.x, p.y, built.centre));
				const d = Math.hypot(sx - cx, sy - cy);
				if (d < bestD) {
					bestD = d;
					best = { kind, index: i, x: cx, y: cy };
				}
			});
		};
		test("quake", data.live.quakes);
		test("fire", data.live.fires);
		if (best) return best;
		const [wx, wz] = ndcRay(cx, cy);
		const mx = wx * UNIT + built.centre[0];
		const my = wz * UNIT + built.centre[1];
		for (let i = 0; i < built.pick.length; i++) {
			const s = built.pick[i];
			if (!s || mx < s.box[0] || mx > s.box[2] || my < s.box[1] || my > s.box[3]) continue;
			if (s.rings.some((r) => inside(r, mx, my))) return { kind: "state", index: i, x: cx, y: cy };
		}
		return null;
	};

	let lastKey = "";
	const onMove = (e: PointerEvent) => {
		wake();
		const r = canvasHost.getBoundingClientRect();
		const cx = e.clientX - r.left;
		const cy = e.clientY - r.top;
		wantYaw = ((cx / r.width) * 2 - 1) * -0.14;
		wantPitch = ((cy / r.height) * 2 - 1) * 0.05;
		const h = hoverAt(cx, cy);
		uHover.value = h?.kind === "state" ? h.index : -1;
		const key = h ? `${h.kind}${h.index}` : "";
		if (key !== lastKey || h) opts.onHover(h);
		lastKey = key;
	};
	const onLeave = () => {
		wake();
		wantYaw = 0;
		wantPitch = 0;
		uHover.value = -1;
		lastKey = "";
		opts.onHover(null);
	};
	canvasHost.addEventListener("pointermove", onMove);
	canvasHost.addEventListener("pointerleave", onLeave);

	// Render only while on screen and the tab is visible, at most 30 frames a second after the intro, and only while
	// something moves: after the intro the loop stops once the camera has settled and the pointer has been still for
	// a moment, and the pointer wakes it. No redraws while idle (battery on a cheap machine).
	let visible = true;
	const io = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
		if (visible) loop();
	});
	io.observe(canvasHost);
	let raf = 0;
	let running = false;
	/** Scene time in seconds: advances only while frames render, so a pause never makes the drift jump. */
	let clock = 0;
	let last = 0;
	let lastDrawn = 0;
	let lastInput = 0;
	let ready = false;
	const INTRO = 3.2;
	const loop = () => {
		cancelAnimationFrame(raf);
		running = true;
		last = 0;
		raf = requestAnimationFrame(frame);
	};
	redraw = () => {
		if (!running) loop();
	};
	const wake = () => {
		lastInput = performance.now();
		if (!running) loop();
	};
	const frame = (now: number) => {
		if (!visible || document.hidden) {
			running = false;
			return;
		}
		if (last) clock += Math.min(now - last, 50) / 1000;
		last = now;
		if (clock > INTRO && now - lastDrawn < 33) {
			raf = requestAnimationFrame(frame);
			return;
		}
		lastDrawn = now;
		uTime.value = clock;
		yaw += (wantYaw - yaw) * 0.06;
		pitch += (wantPitch - pitch) * 0.06;
		place(clock);
		renderer.render({ scene, camera });
		if (!ready) {
			ready = true;
			opts.onReady();
		}
		const settled = Math.abs(wantYaw - yaw) < 1e-4 && Math.abs(wantPitch - pitch) < 1e-4;
		if (clock > INTRO && settled && now - lastInput > 1500) {
			running = false;
			return;
		}
		raf = requestAnimationFrame(frame);
	};
	const onVisibility = () => !document.hidden && loop();
	document.addEventListener("visibilitychange", onVisibility);
	const onLost = (e: Event) => {
		e.preventDefault();
		cancelAnimationFrame(raf);
		opts.onLost();
	};
	canvas.addEventListener("webglcontextlost", onLost);
	loop();

	return {
		setPalette(p: Palette) {
			pal = p;
			statesProgram.uniforms.uLand = { value: p.land };
			statesProgram.uniforms.uSide = { value: p.side };
			statesProgram.uniforms.uWarn = { value: p.warn };
			statesProgram.uniforms.uAlert = { value: p.alert };
			statesProgram.uniforms.uDark = { value: p.dark ? 1 : 0 };
			bordersProgram.uniforms.uColor = { value: p.border };
			neighboursProgram.uniforms.uColor = { value: p.neighbour };
			gridProgram.uniforms.uColor = { value: p.grid };
			quakeProgram.uniforms.uColor = { value: p.signal };
			fireProgram.uniforms.uColor = { value: p.warn };
			loop();
		},
		destroy() {
			cancelAnimationFrame(raf);
			io.disconnect();
			ro.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			canvasHost.removeEventListener("pointermove", onMove);
			canvasHost.removeEventListener("pointerleave", onLeave);
			canvas.removeEventListener("webglcontextlost", onLost);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
			canvas.remove();
		},
	};
}
