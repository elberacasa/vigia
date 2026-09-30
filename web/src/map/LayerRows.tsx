import { later } from "../lib/lazy.tsx";

/*
 * The point layers under "Encima" as chunks loaded the first time they are switched on; their rows (except quakes
 * and heat spots, in LayerList) are a chunk of their own too (MoreRows.tsx), drawn once it arrives.
 */

export const FlareLayer = later(() => import("./FlareLayer.tsx").then((m) => m.FlareLayer));
export const FlareLegend = later(() => import("./FlareLayer.tsx").then((m) => m.FlareLegend));

/** Facilities (ontology): the layer, its data and its key load only once it is switched on. */
export const FacilityLayer = later(() => import("./FacilityLayer.tsx").then((m) => m.FacilityLayer));
export const FacilityLegend = later(() => import("./FacilityLayer.tsx").then((m) => m.FacilityLegend));

/** The layer and its key load only once the layer is switched on (the phone's first load stays as it was). */
export const LightningLayer = later(() => import("./LightningLayer.tsx").then((m) => m.LightningLayer));
export const LightningLegend = later(() => import("./LightningLayer.tsx").then((m) => m.LightningLegend));

/** Public cameras: the layer, its data and its strip load only once it is switched on. */
export const CameraLayer = later(() => import("./CameraLayer.tsx").then((m) => m.CameraLayer));
export const CameraLegend = later(() => import("./CameraLayer.tsx").then((m) => m.CameraLegend));
export const CameraStrip = later(() => import("./CameraLayer.tsx").then((m) => m.CameraStrip));

/** User reports: hatched municipalities; the outlines and the view load once it is switched on. */
export const CrowdLayer = later(() => import("./CrowdLayer.tsx").then((m) => m.CrowdLayer));
export const CrowdLegend = later(() => import("./CrowdLayer.tsx").then((m) => m.CrowdLegend));

/** Space layers (NASA MODIS floods, Carbon Mapper plumes): chunks and views loaded when switched on. */
export const FloodLayer = later(() => import("./SpaceLayers.tsx").then((m) => m.FloodLayer));
export const FloodLegend = later(() => import("./SpaceLayers.tsx").then((m) => m.FloodLegend));
export const PlumeLayer = later(() => import("./SpaceLayers.tsx").then((m) => m.PlumeLayer));
export const PlumeLegend = later(() => import("./SpaceLayers.tsx").then((m) => m.PlumeLegend));

/** The rows of the layers added in 2026-09 (cameras, user reports, floods, plumes): a chunk of their own. */
export const MoreRows = later(() => import("./MoreRows.tsx").then((m) => m.MoreRows));
