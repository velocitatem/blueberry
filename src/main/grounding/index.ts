import { createLogger } from "../logger";
import type { WebContents } from "electron";
import type { Grounder } from "./Grounder";
import { ServerGrounder } from "./ServerGrounder";
import { WebGpuGrounder } from "./WebGpuGrounder";

const log = createLogger("grounder");

export type { Grounder, GroundRequest, GroundResult } from "./Grounder";
export {
  boxCenter,
  resultToPoint,
  normalizedToViewport,
  parseGroundingOutput,
} from "./Grounder";
export { ServerGrounder } from "./ServerGrounder";
export { WebGpuGrounder } from "./WebGpuGrounder";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765/ground";

/**
 * Select the grounding backend. Swapping backends is a one-line env change:
 *   GROUNDER=server  — call a local LocateAnything HTTP server (the real weights;
 *                      see grounder_provider/). GROUNDER_URL overrides
 *                      the endpoint (default http://127.0.0.1:8765/ground).
 *   GROUNDER=webgpu  — run LocateAnything in the sidebar renderer via WebGPU
 *                      when a compatible JS/WebGPU model runtime is available.
 *   GROUNDER=off     — disable grounding; click tools fall back to CSS selectors.
 */
export const createGrounder = (webContents?: WebContents): Grounder | null => {
  const backend = (process.env.GROUNDER ?? "server").toLowerCase();
  if (backend === "off" || backend === "none" || backend === "0") return null;
  if (backend === "server") {
    const url = process.env.GROUNDER_URL || DEFAULT_SERVER_URL;
    log.info({ backend, url }, "grounder: server backend");
    return new ServerGrounder(url);
  }
  log.info({ backend }, "grounder: webgpu backend");
  if (!webContents) {
    log.warn("grounder: webgpu backend requested without renderer webContents");
    return null;
  }
  return new WebGpuGrounder(webContents);
};
