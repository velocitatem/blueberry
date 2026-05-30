/**
 * Visual grounding abstraction.
 *
 * A Grounder takes a screenshot plus a natural-language description of a target
 * and returns its location. This lets the frontier model plan in plain language
 * ("click the Sign in button") while a small, local model resolves the pixels —
 * avoiding HTML/selector-hunting round-trips in the frontier context.
 *
 * Coordinates are normalized integers in [0, 1000], matching LocateAnything-3B's
 * output format (`<box><x1><y1><x2><y2></box>` / `<box><x><y></box>`).
 */

export type GroundOutput = "box" | "point";

export interface GroundRequest {
  /** Data URL (PNG) of the active tab screenshot. Stays local; never sent to the frontier model. */
  imageDataUrl: string;
  /** Free-form target, e.g. "the blue Sign in button". */
  description: string;
  /** Whether to return a bounding box or a single point. */
  output: GroundOutput;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface NormalizedBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GroundResult {
  point?: NormalizedPoint;
  box?: NormalizedBox;
}

export interface Grounder {
  /** Resolve a description to coordinates, or null when grounding is unavailable. */
  ground(req: GroundRequest): Promise<GroundResult | null>;
}

/** Center of a normalized box. */
export const boxCenter = (b: NormalizedBox): NormalizedPoint => ({
  x: Math.round((b.x1 + b.x2) / 2),
  y: Math.round((b.y1 + b.y2) / 2),
});

/** Pick the best point from a result (explicit point, else box center). */
export const resultToPoint = (r: GroundResult | null): NormalizedPoint | null => {
  if (!r) return null;
  if (r.point) return r.point;
  if (r.box) return boxCenter(r.box);
  return null;
};

/**
 * Map a normalized point [0, 1000] to CSS/viewport pixels.
 *
 * The model's normalized coords correspond to the captured viewport, so mapping
 * via the page's innerWidth/innerHeight sidesteps device-pixel-ratio entirely —
 * these are exactly the coordinates `webContents.sendInputEvent` expects.
 */
export const normalizedToViewport = (
  p: NormalizedPoint,
  viewport: { innerWidth: number; innerHeight: number },
): NormalizedPoint => ({
  x: Math.round((p.x / 1000) * viewport.innerWidth),
  y: Math.round((p.y / 1000) * viewport.innerHeight),
});

/**
 * Parse raw LocateAnything text output into a structured result.
 * Useful for server-backed grounders that return the raw token sequence.
 * Tries box first (4 ints), then point (2 ints).
 */
export const parseGroundingOutput = (text: string): GroundResult | null => {
  const box = /<box><(\d+)><(\d+)><(\d+)><(\d+)><\/box>/.exec(text);
  if (box) {
    const [, x1, y1, x2, y2] = box;
    return { box: { x1: +x1, y1: +y1, x2: +x2, y2: +y2 } };
  }
  const point = /<box><(\d+)><(\d+)><\/box>/.exec(text);
  if (point) {
    const [, x, y] = point;
    return { point: { x: +x, y: +y } };
  }
  return null;
};
