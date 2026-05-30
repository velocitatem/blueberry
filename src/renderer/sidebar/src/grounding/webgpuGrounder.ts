import { createLogger } from "@common/lib/logger";

const log = createLogger("grounder");
const MODEL_ID = "checkpoints/LocateAnything";

type GroundOutput = "box" | "point";

interface GroundRequest {
  id: string;
  imageDataUrl: string;
  description: string;
  output: GroundOutput;
}

interface GroundResult {
  point?: { x: number; y: number };
  box?: { x1: number; y1: number; x2: number; y2: number };
}

interface PredictOptions {
  generationMode?: "fast" | "slow" | "hybrid";
  maxNewTokens?: number;
  temperature?: number;
  verbose?: boolean;
}

interface Prediction {
  answer: string;
  history?: unknown;
  stats?: unknown;
}

type UnknownRecord = Record<string, unknown>;
type FromPretrained = {
  from_pretrained: (
    modelPath: string,
    options?: UnknownRecord,
  ) => Promise<unknown> | unknown;
};
type TransformersModule = {
  AutoTokenizer?: FromPretrained;
  AutoProcessor?: FromPretrained;
  AutoModel?: FromPretrained;
  env?: UnknownRecord;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const hasProperties = (
  value: unknown,
): value is UnknownRecord | ((...args: unknown[]) => unknown) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const prop = (value: unknown, key: string): unknown =>
  hasProperties(value) ? (value as UnknownRecord)[key] : undefined;

const call = async <T>(
  target: unknown,
  thisArg: unknown,
  ...args: unknown[]
): Promise<T> => {
  if (typeof target !== "function") {
    throw new Error("LocateAnything runtime method is unavailable");
  }
  return await (target as (...fnArgs: unknown[]) => Promise<T> | T).apply(
    thisArg,
    args,
  );
};

const maybeCall = async <T>(
  target: unknown,
  thisArg: unknown,
  fallback: T,
  ...args: unknown[]
): Promise<T> => {
  if (typeof target !== "function") return fallback;
  return await (target as (...fnArgs: unknown[]) => Promise<T> | T).apply(
    thisArg,
    args,
  );
};

const extractText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return extractText(value[0]);
  if (!isRecord(value)) return String(value ?? "");

  for (const key of ["generated_text", "text", "answer", "output"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }

  return String(value);
};

const normalizePrediction = (response: unknown): Prediction => {
  if (Array.isArray(response) && response.length >= 3) {
    return {
      answer: extractText(response[0]),
      history: response[1],
      stats: response[2],
    };
  }
  return { answer: extractText(response) };
};

const toDevice = async (value: unknown, device: string): Promise<unknown> =>
  hasProperties(value)
    ? await maybeCall(prop(value, "to"), value, value, device)
    : value;

const toDtype = async (value: unknown, dtype: string): Promise<unknown> =>
  hasProperties(value)
    ? await maybeCall(prop(value, "to"), value, value, dtype)
    : value;

const imageFromDataUrl = async (imageDataUrl: string): Promise<unknown> => {
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  if ("createImageBitmap" in window) return await createImageBitmap(blob);
  return imageDataUrl;
};

const firstBox = (answer: string): GroundResult | null => {
  const match = /<box><(\d+)><(\d+)><(\d+)><(\d+)><\/box>/.exec(answer);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match;
  return { box: { x1: +x1, y1: +y1, x2: +x2, y2: +y2 } };
};

const firstPoint = (answer: string): GroundResult | null => {
  const match = /<box><(\d+)><(\d+)><\/box>/.exec(answer);
  if (!match) return null;
  const [, x, y] = match;
  return { point: { x: +x, y: +y } };
};

const resultFromAnswer = (
  answer: string,
  output: GroundOutput,
): GroundResult | null =>
  output === "point"
    ? (firstPoint(answer) ?? firstBox(answer))
    : (firstBox(answer) ?? firstPoint(answer));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isModelLoadFailure = (error: unknown): boolean => {
  const message = errorMessage(error);
  return (
    message.includes("tokenizer_class") ||
    message.includes("Failed to fetch") ||
    message.includes("AutoTokenizer") ||
    message.includes("AutoProcessor") ||
    message.includes("AutoModel") ||
    message.includes("Unsupported model")
  );
};

class LocateAnythingWebGpuWorker {
  private tokenizer: unknown = null;
  private processor: unknown = null;
  private model: unknown = null;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly modelPath: string,
    private readonly device = "webgpu",
    private readonly dtype = "fp16",
  ) {}

  async load(): Promise<void> {
    if (this.ready) return await this.ready;
    this.ready = this.loadRuntime();
    return await this.ready;
  }

  async predict(
    imageDataUrl: string,
    question: string,
    {
      generationMode = "hybrid",
      maxNewTokens = 2048,
      temperature = 0.7,
      verbose = true,
    }: PredictOptions = {},
  ): Promise<Prediction> {
    await this.load();

    const image = await imageFromDataUrl(imageDataUrl);
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", image },
          { type: "text", text: question },
        ],
      },
    ];

    if (!hasProperties(this.processor) || !hasProperties(this.model)) {
      throw new Error("LocateAnything runtime is not loaded");
    }

    const text = await maybeCall(
      prop(this.processor, "py_apply_chat_template"),
      this.processor,
      question,
      messages,
      false,
      true,
    );
    const vision = await maybeCall<{ images?: unknown; videos?: unknown }>(
      prop(this.processor, "process_vision_info"),
      this.processor,
      { images: [image], videos: undefined },
      messages,
    );
    const inputs = await toDevice(
      await call(this.processor, this.processor, {
        text: [text],
        images: vision.images ?? [image],
        videos: vision.videos,
        return_tensors: "pt",
      }),
      this.device,
    );

    if (!isRecord(inputs))
      throw new Error("LocateAnything processor returned invalid inputs");

    const pixelValues = await toDtype(inputs.pixel_values, this.dtype);
    const response = await call(prop(this.model, "generate"), this.model, {
      pixel_values: pixelValues,
      input_ids: inputs.input_ids,
      attention_mask: inputs.attention_mask,
      image_grid_hws: inputs.image_grid_hws,
      tokenizer: this.tokenizer,
      max_new_tokens: maxNewTokens,
      use_cache: true,
      generation_mode: generationMode,
      temperature,
      do_sample: true,
      top_p: 0.9,
      repetition_penalty: 1.1,
      verbose,
    });

    return normalizePrediction(response);
  }

  async detect(
    imageDataUrl: string,
    categories: string[],
    options?: PredictOptions,
  ): Promise<Prediction> {
    return await this.predict(
      imageDataUrl,
      `Locate all the instances that matches the following description: ${categories.join("</c>")}.`,
      options,
    );
  }

  async groundSingle(
    imageDataUrl: string,
    phrase: string,
    options?: PredictOptions,
  ): Promise<Prediction> {
    return await this.predict(
      imageDataUrl,
      `Locate a single instance that matches the following description: ${phrase}.`,
      options,
    );
  }

  async groundMulti(
    imageDataUrl: string,
    phrase: string,
    options?: PredictOptions,
  ): Promise<Prediction> {
    return await this.predict(
      imageDataUrl,
      `Locate all the instances that match the following description: ${phrase}.`,
      options,
    );
  }

  async groundText(
    imageDataUrl: string,
    phrase: string,
    options?: PredictOptions,
  ): Promise<Prediction> {
    return await this.predict(
      imageDataUrl,
      `Please locate the text referred as ${phrase}.`,
      options,
    );
  }

  async detectText(
    imageDataUrl: string,
    options?: PredictOptions,
  ): Promise<Prediction> {
    return await this.predict(
      imageDataUrl,
      "Detect all the text in box format.",
      options,
    );
  }

  async groundGui(
    imageDataUrl: string,
    phrase: string,
    outputType: GroundOutput = "box",
    options?: PredictOptions,
  ): Promise<Prediction> {
    const prompt =
      outputType === "point"
        ? `Point to: ${phrase}.`
        : `Locate the region that matches the following description: ${phrase}.`;
    return await this.predict(imageDataUrl, prompt, options);
  }

  async point(
    imageDataUrl: string,
    phrase: string,
    options?: PredictOptions,
  ): Promise<Prediction> {
    return await this.predict(imageDataUrl, `Point to: ${phrase}.`, options);
  }

  static parseBoxes(
    answer: string,
    imageWidth: number,
    imageHeight: number,
  ): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> {
    return Array.from(
      answer.matchAll(/<box><(\d+)><(\d+)><(\d+)><(\d+)><\/box>/g),
      (match) => {
        const [, x1, y1, x2, y2] = match;
        return {
          x1: (+x1 / 1000) * imageWidth,
          y1: (+y1 / 1000) * imageHeight,
          x2: (+x2 / 1000) * imageWidth,
          y2: (+y2 / 1000) * imageHeight,
        };
      },
    );
  }

  static parsePoints(
    answer: string,
    imageWidth: number,
    imageHeight: number,
  ): Array<{ x: number; y: number }> {
    return Array.from(
      answer.matchAll(/<box><(\d+)><(\d+)><\/box>/g),
      (match) => {
        const [, x, y] = match;
        return {
          x: (+x / 1000) * imageWidth,
          y: (+y / 1000) * imageHeight,
        };
      },
    );
  }

  private async loadRuntime(): Promise<void> {
    const transformers =
      (await import("@huggingface/transformers")) as TransformersModule;
    if (
      !transformers.AutoTokenizer ||
      !transformers.AutoProcessor ||
      !transformers.AutoModel
    ) {
      throw new Error(
        "LocateAnything requires AutoTokenizer, AutoProcessor, and AutoModel",
      );
    }

    this.tokenizer = await transformers.AutoTokenizer.from_pretrained(
      this.modelPath,
      {
        trust_remote_code: true,
      },
    );
    this.processor = await transformers.AutoProcessor.from_pretrained(
      this.modelPath,
      {
        trust_remote_code: true,
      },
    );
    this.model = await transformers.AutoModel.from_pretrained(this.modelPath, {
      dtype: this.dtype,
      device: this.device,
      trust_remote_code: true,
    });
    await maybeCall(prop(this.model, "eval"), this.model, undefined);
  }
}

/**
 * Run grounding in-browser via WebGPU.
 *
 * This mirrors the Python LocateAnything worker shape: load model/tokenizer/
 * processor once, build the task-specific prompt, generate, then parse the
 * normalized `<box>...</box>` answer. If the JS/WebGPU runtime or model export is
 * unavailable, callers receive null and gracefully fall back.
 */
const worker = new LocateAnythingWebGpuWorker(
  window.localStorage.getItem("locateanything:model") ?? MODEL_ID,
);
let unavailableReason: string | null = null;

const runGrounding = async (
  req: GroundRequest,
): Promise<GroundResult | null> => {
  if (unavailableReason) return null;

  try {
    const prediction = await worker.groundGui(
      req.imageDataUrl,
      req.description,
      req.output,
    );
    const result = resultFromAnswer(prediction.answer, req.output);
    log.debug(
      { description: req.description, answer: prediction.answer, result },
      "grounding completed",
    );
    return result;
  } catch (error) {
    if (!isModelLoadFailure(error)) throw error;

    unavailableReason =
      `WebGPU grounding model is unavailable: ${errorMessage(error)}. ` +
      "Use GROUNDER=server for the PyTorch worker, or provide a browser-loadable ONNX/WebGPU model.";
    log.warn({ reason: unavailableReason }, "webgpu grounding unavailable");
    return null;
  }
};

let initialized = false;

export const initWebGpuGrounder = (): void => {
  if (initialized) return;
  const api = window.sidebarAPI;
  if (!api?.onGroundRequest || !api?.sendGroundResult) return;
  initialized = true;

  api.onGroundRequest(async (req) => {
    try {
      const result = await runGrounding(req);
      api.sendGroundResult({ id: req.id, result });
    } catch (error) {
      log.error({ err: error }, "grounding failed");
      api.sendGroundResult({
        id: req.id,
        result: null,
        error: error instanceof Error ? error.message : "grounding failed",
      });
    }
  });

  log.info("WebGPU grounder listener registered");
};
