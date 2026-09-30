import { lazy } from "../lib/lazy.tsx";

/** The secondary pages, each its own chunk (loaded on first visit): shared by the phone layout and the desk shell. */
export const StatusPage = lazy(() => import("../pages/Status.tsx").then((m) => m.StatusPage));
export const SourcesPage = lazy(() => import("../pages/Sources.tsx").then((m) => m.SourcesPage));
export const GuidePage = lazy(() => import("../pages/Guide.tsx").then((m) => m.GuidePage));
export const AiPage = lazy(() => import("../pages/Ai.tsx").then((m) => m.AiPage));
export const BriefPage = lazy(() => import("../pages/Brief.tsx").then((m) => m.BriefPage));
export const BlockLookupPage = lazy(() => import("../pages/BlockLookup.tsx").then((m) => m.BlockLookupPage));
export const EntityPage = lazy(() => import("../pages/Entity.tsx").then((m) => m.EntityPage));
