import { expect, test } from "bun:test";
import { visibleRange } from "./VirtualList.tsx";

// Whole-release review, B4: on the desk the list sits in .ws__page, whose top is below the command bar; measured
// against the window it rendered nothing. The band is the scroller's visible part.
test("rows follow the scroller's visible band, not the window", () => {
	// A list 600 px down a scroller that shows 60–860 px of the viewport: the first screen of rows is rendered.
	expect(visibleRange(600, 60, 860, 40, 350)).toEqual([0, 16]);
	// Scrolled so the list's top is 2,000 px above the band: rows around 51–71 (with overscan, in steps of 8).
	expect(visibleRange(-1_940, 60, 860, 40, 350)).toEqual([40, 80]);
	// Never past the end, never negative.
	expect(visibleRange(-100_000, 60, 860, 40, 350)).toEqual([350, 350]);
	expect(visibleRange(5_000, 60, 860, 40, 350)).toEqual([0, 0]);
});
