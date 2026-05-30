// bun run grounder:server to boot it up
import { createLogger } from "../logger";
import {
  parseGroundingOutput,
  type Grounder,
  type GroundRequest,
  type GroundResult,
} from "./Grounder";

const log = createLogger("grounder");

interface ServerResponse {
  point?: { x: number; y: number };
  box?: { x1: number; y1: number; x2: number; y2: number };
  /** Raw model text (e.g. "<box><500><500></box>"); parsed if point/box absent. */
  answer?: string;
}

/**
 * Grounds against a local HTTP server running the real LocateAnything-3B weights
 * (see grounder_provider/). Runs in the main process — no WebGPU,
 * no renderer round-trip. The server returns normalized coordinates (0..1000),
 * the same space the click tools expect.
 *
 * This is the "use the real model today" backend; select it with GROUNDER=server.
 */
export class ServerGrounder implements Grounder {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async ground(req: GroundRequest): Promise<GroundResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn({ status: res.status, url: this.url }, "grounding server error");
        return null;
      }
      const data = (await res.json()) as ServerResponse;
      if (data.point || data.box) return { point: data.point, box: data.box };
      if (typeof data.answer === "string") return parseGroundingOutput(data.answer);
      return null;
    } catch (err) {
      log.warn({ err, url: this.url }, "grounding request failed");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
