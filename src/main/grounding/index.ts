import { createLogger } from "../logger";
import type { WebContents } from "electron";
import type { Grounder } from "./Grounder";
import { ServerGrounder } from "./ServerGrounder";

const log = createLogger("grounder");

export type { Grounder, GroundRequest, GroundResult } from "./Grounder";
export {
  boxCenter,
  resultToPoint,
  normalizedToViewport,
  parseGroundingOutput,
} from "./Grounder";
export { ServerGrounder } from "./ServerGrounder";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765/ground";

export const createGrounder = (webContents?: WebContents): Grounder | null => {
  if (!webContents) log.warn("grounder: no webContents provided");
  return new ServerGrounder(DEFAULT_SERVER_URL) || null;
};
