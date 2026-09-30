# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.*", "tifffile==2025.*", "imagecodecs==2025.*", "shapely==2.1.*"]
# ///
"""Aggregate the WorldPop 2026 grid to Venezuela's municipalities and parishes, and to a coarse grid.

Python only because it reads a GeoTIFF raster (the project uses Python only where a geospatial library needs it).

Run (from the repository root; single core, a few seconds):
    uv run scripts/ontology/population.py data/ontology/raw data/geo/raw/cod-fixed > data/ontology/population-worldpop.json

Inputs:
  <raw>/ven_pop_2026_CN_1km_R2025A_UA_v1.tif   WorldPop Global2 R2025A, constrained, 30 arc-second cells (~1 km),
                                               people per cell, 2026 (CC BY 4.0). A modelled estimate, not a count.
  <cod>/ven_admin2.geojson, ven_admin3.geojson  OCHA COD-AB Venezuela v01, full resolution (CC BY-IGO 3.0).

Method (stated in the output, and in the UI as "calculado por Vigía"):
  - Each cell's people are assigned to the municipality (and parish) whose full-resolution polygon contains the
    cell's centre. Cells whose centre falls outside every polygon (coast, lake shore) go to the nearest polygon
    within 3 km, else they are counted as "unassigned" and reported.
  - The coarse grid sums cells into blocks of BLOCK x BLOCK (0.025 degrees, ~2.8 km), keyed by block row and column
    from the grid origin, for "people within R km of a point" (the sum of blocks whose centre is within R km).
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import shapely
import tifffile
from numpy.typing import NDArray

TIF = "ven_pop_2026_CN_1km_R2025A_UA_v1.tif"
BLOCK = 3
NEAREST_MAX_DEG = 0.027  # ~3 km


def load_grid(path: Path) -> tuple[NDArray[np.float64], float, float, float, float]:
    with tifffile.TiffFile(path) as tif:
        page = tif.pages.first
        data = page.asarray().astype(np.float64)
        tags = page.tags
        scale = tags["ModelPixelScaleTag"].value
        tie = tags["ModelTiepointTag"].value
        nodata_tag = tags.get("GDAL_NODATA")
        nodata = float(nodata_tag.value) if nodata_tag is not None else None
    if nodata is not None:
        data[data == nodata] = 0.0
    data[~np.isfinite(data)] = 0.0
    data[data < 0] = 0.0
    # Tiepoint maps raster (i, j) = (tie[0], tie[1]) to model (x, y) = (tie[3], tie[4]); pixel-is-area.
    x0 = float(tie[3]) - float(tie[0]) * float(scale[0])
    y0 = float(tie[4]) + float(tie[1]) * float(scale[1])
    return data, x0, y0, float(scale[0]), float(scale[1])


def load_polygons(path: Path, code_field: str) -> tuple[list[str], list[Any]]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    codes: list[str] = []
    geoms: list[Any] = []
    for feature in doc["features"]:
        props = feature["properties"]
        # Dependencias Federales' placeholder unit (VE2501 / VE250101) is kept: its islands have people too, and
        # the registry files them under the state.
        codes.append(str(props[code_field]))
        geoms.append(shapely.geometry.shape(feature["geometry"]))
    return codes, geoms


def assign(
    xs: NDArray[np.float64], ys: NDArray[np.float64], codes: list[str], geoms: list[Any]
) -> tuple[NDArray[np.int64], int]:
    """Index into `codes` of the polygon containing each point; -1 when none within NEAREST_MAX_DEG."""
    tree = shapely.STRtree(geoms)
    points = shapely.points(xs, ys)
    out = np.full(len(xs), -1, dtype=np.int64)
    pairs = tree.query(points, predicate="within")
    # pairs[0] = point index, pairs[1] = polygon index; a point on a shared edge may hit two: keep the first.
    seen = np.zeros(len(xs), dtype=bool)
    for p, g in zip(pairs[0].tolist(), pairs[1].tolist(), strict=True):
        if not seen[p]:
            out[p] = g
            seen[p] = True
    missing = np.flatnonzero(out < 0)
    nearest = 0
    if len(missing):
        idx = tree.query_nearest(points[missing], max_distance=NEAREST_MAX_DEG, all_matches=False)
        for m, g in zip(idx[0].tolist(), idx[1].tolist(), strict=True):
            out[missing[m]] = g
            nearest += 1
    return out, nearest


def main() -> None:
    raw = Path(sys.argv[1])
    cod = Path(sys.argv[2])
    data, x0, y0, dx, dy = load_grid(raw / TIF)
    rows, cols = np.nonzero(data > 0)
    values = data[rows, cols]
    xs: NDArray[np.float64] = (x0 + (cols + 0.5) * dx).astype(np.float64)
    ys: NDArray[np.float64] = (y0 - (rows + 0.5) * dy).astype(np.float64)
    total = float(values.sum())

    m_codes, m_geoms = load_polygons(cod / "ven_admin2.geojson", "adm2_pcode")
    p_codes, p_geoms = load_polygons(cod / "ven_admin3.geojson", "adm3_pcode")
    m_idx, m_nearest = assign(xs, ys, m_codes, m_geoms)
    p_idx, p_nearest = assign(xs, ys, p_codes, p_geoms)

    def sums(idx: NDArray[np.int64], codes: list[str]) -> tuple[dict[str, int], float]:
        acc = np.zeros(len(codes))
        ok = idx >= 0
        np.add.at(acc, idx[ok], values[ok])
        return {c: round(float(v)) for c, v in zip(codes, acc.tolist(), strict=True)}, float(values[~ok].sum())

    municipalities, m_unassigned = sums(m_idx, m_codes)
    parishes, p_unassigned = sums(p_idx, p_codes)

    # Coarse grid: blocks of BLOCK x BLOCK cells, summed; only blocks with at least one person.
    brow = rows // BLOCK
    bcol = cols // BLOCK
    key = brow * 100_000 + bcol
    order = np.argsort(key)
    k_sorted = key[order]
    v_sorted = values[order]
    uniq, start = np.unique(k_sorted, return_index=True)
    block_sums = np.add.reduceat(v_sorted, start)
    blocks = [
        [int(k // 100_000), int(k % 100_000), round(float(v))]
        for k, v in zip(uniq.tolist(), block_sums.tolist(), strict=True)
        if round(float(v)) > 0
    ]

    out = {
        "meta": {
            "generatedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generator": "scripts/ontology/population.py",
            "source": {
                "title": "WorldPop Global2 R2025A, constrained population counts, 2026, 30 arc-second (~1 km)",
                "url": "https://hub.worldpop.org/geodata/listing?id=135",
                "file": TIF,
                "licence": "CC BY 4.0",
                "attribution": "WorldPop (www.worldpop.org), University of Southampton; Global2 R2025A (CC BY 4.0)",
            },
            "boundaries": "OCHA COD-AB Venezuela v01, full resolution (CC BY-IGO 3.0)",
            "method": (
                "Suma de las celdas de ~1 km de WorldPop 2026 cuyo centro cae en cada municipio o parroquia "
                "(límites COD-AB a resolución completa); las celdas costeras fuera de todo polígono van al más "
                "cercano a menos de 3 km. Es una estimación modelada, no un censo."
            ),
            "gridTotal": round(total),
            "unassigned": {"municipalities": round(m_unassigned), "parishes": round(p_unassigned)},
            "assignedByNearest": {"municipalities": m_nearest, "parishes": p_nearest},
            "cells": len(values),
        },
        "municipalities": municipalities,
        "parishes": parishes,
        "grid": {
            "originLon": x0,
            "originLat": y0,
            "cellDeg": dx * BLOCK,
            "note": "Bloques de 3x3 celdas (0.025 grados); [fila, columna, personas] desde el origen (esquina NO).",
            "blocks": blocks,
        },
    }
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
