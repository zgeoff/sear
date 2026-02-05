# Screen OCR & Computer Vision Framework — Early Technical Design (v0)

> **Status:** Early architecture / design discussion  
> **Audience:** AI coding agents, future contributors  
> **Primary goal:** Establish a strong DX-first foundation for a modular, real-time OCR/CV framework for arbitrary window/screen content (Windows)

---

## 1. Goals & Non-Goals

### Goals
- Build a **job-driven, modular OCR/CV pipeline** for analyzing window or screen content in real time.
- Optimize for **developer experience (DX)** first, performance second, with clear seams for later optimization.
- Support **static and dynamic ROIs**, including CV-detected UI elements that move on screen.
- Provide a **first-class inspector/debugging experience** with live overlay, telemetry, recording, and replay.
- Keep the **core pipeline in TypeScript**, while allowing incremental migration of hot paths to native/Rust.

### Non-Goals (v0)
- No in-process injection or hooking of target applications.
- No cross-platform support initially (Windows only).
- No fully automated UI layout inference beyond explicit CV detection jobs.
- No distributed or cloud execution.
- No production-grade observability backend (local telemetry only).

---

## 2. High-Level Architecture

### Runtime / Host
- **Electron** desktop application
- **Main Node process** runs the pipeline
- Renderer processes are UI only:
  - Inspector UI
  - Transparent overlay window

### Core Components
```
Electron Main Process
 ├─ Capture Adapter (Win APIs)
 ├─ FrameStore (handle-based)
 ├─ Pipeline (scheduler + jobs + modules)
 ├─ Telemetry
 └─ IPC → Renderer Windows
```

---

## 3. Capture Strategy

### Supported Capture Modes
1. **Window capture (primary)**
2. **Display capture (fallback)**

### Capture Policies
- Prefer window capture.
- Fallback to display capture when window capture fails.
- Recommend borderless windowed mode where applicable.

### Capture Outputs
- **Full-resolution frame handles**
  - Used for ROI cropping and analysis.
  - Only latest frame or small ring buffer retained.
- **Preview frame handles**
  - Downscaled for UI display (5–15 FPS).

### CaptureContext (authoritative geometry)
```ts
type CaptureContext = {
  frameWidth: number;
  frameHeight: number;
  clientRect: { x: number; y: number; width: number; height: number };
  dpiScale?: number; // undefined = 1.0 (no scaling)
  mode: 'window' | 'display';
};
```

> **`dpiScale`:** For HiDPI/Retina displays, `dpiScale` indicates the ratio between logical pixels (CSS/UI) and physical pixels (frame buffer). When defined, anchor-based ROIs use logical coordinates and are scaled to physical pixels during resolution. Undefined means no scaling (1:1).

CaptureContext changes trigger ROI re-resolution and overlay realignment.

### Capture Interface
```ts
type CaptureTarget =
  | { type: 'window'; windowID: string }
  | { type: 'display'; displayID: string };

// Target IDs are opaque strings obtained from platform-specific enumeration APIs
// (e.g., OS window listing, display enumeration). The Capture implementation
// interprets these — consumers just pass them through.

interface Capture {
  start(target: CaptureTarget): void;
  stop(): void;
  getLatestFrame(): FrameHandle | null;
  getContext(): CaptureContext | null;
  onContextChange(callback: (ctx: CaptureContext) => void): Unsubscribe;
}

function createCapture(store: FrameStore): Capture;
```

The capture layer is responsible for:
- Acquiring frames from the target window or display
- Storing frames in `FrameStore` via `putFrame()` (internal implementation detail — not exposed in the `Capture` interface)
- Tracking and emitting `CaptureContext` changes

> **Note:** The `Capture` implementation holds a reference to `FrameStore` internally. When a new frame is acquired, it calls `store.putFrame()` and tracks the returned handle. Consumers only interact with `getLatestFrame()` — they don't need to manage storage directly.

> **`start`/`stop` behavior:**
> - Calling `start()` while already capturing throws.
> - Calling `start()` with an invalid target throws.
> - Calling `stop()` while not capturing is a no-op.
> - To switch targets, call `stop()` then `start()` with the new target.

---

## 4. FrameStore (Handles-First)

### Principles
- Images referenced by **opaque handles**, not buffers.
- Bounded memory usage (generous ring buffer to reduce eviction pressure).
- Explicit pin/release lifecycle with **reference counting**.
- Eviction based on **frame count** (oldest frames evicted first), but only when refcount = 0.

### Pin/Release Semantics
- `pin(handle)` increments refcount.
- `release(handle)` decrements refcount.
- Frame is only eligible for eviction when refcount reaches 0.
- Multiple consumers can pin the same frame; it stays alive until all release.

```ts
// Scheduler gets latest frame from capture, pins once per job dispatched
const frame = capture.getLatestFrame(); // FrameSource concern, not FrameStore
for (const job of readyJobs) {
  store.pin(frame);
  runJob(job, frame)
    .finally(() => store.release(frame));
}
```

> **Note:** `getLatestFrame()` belongs to the capture/frame-source abstraction, not `FrameStore`. The store manages memory and handles; the capture layer tracks which frame is current.

### Conceptual Contract
```ts
type FrameHandle = { id: FrameID }; // FrameID defined in Section 7.0

type FrameMeta = {
  width: number;
  height: number;
  format: 'rgba';  // Raw RGBA pixels, 4 bytes per pixel
};

interface FrameStore {
  putFrame(bytes: Uint8Array, meta: FrameMeta): FrameHandle;
  crop(handle: FrameHandle, roiPx: ROIPx): FrameHandle; // ROIPx defined in Section 6
  readBytes(handle: FrameHandle): Uint8Array;
  pin(handle: FrameHandle): void;
  release(handle: FrameHandle): void;
}

function createFrameStore(config?: {
  maxFrames?: number; // Default: 30. Ring buffer size.
}): FrameStore;
```

> **Image format:** Frames are stored as raw RGBA pixels (4 bytes per pixel, no compression). At 1080p (~8MB/frame), 30 frames ≈ 240MB. Tune `maxFrames` based on available memory and capture resolution.

> **`putFrame` behavior:**
> - Returned handle starts **unpinned** (refcount = 0). Pin immediately if needed beyond current tick.
> - When buffer is full, the **oldest unpinned frame** is evicted automatically.
> - If all frames are pinned and buffer is full, `putFrame` throws — this indicates a leak (unbounded pinning).

> **Note:** `FrameHandle` is used consistently throughout (job results, telemetry events, etc.). Access `handle.id` for the underlying branded `FrameID` (see Section 7.0).

### Handle Validity
```ts
interface FrameStore {
  // ...
  isValid(handle: FrameHandle): boolean; // Live check against store
}
```

**Behavior on invalid handle operations (e.g., `pin()`, `readBytes()`):**
- **Dev mode:** Log warning, operation no-ops or returns `undefined`.
- **Prod mode:** Throw — invalid handle use is a bug.

Callers should use `store.isValid(handle)` for proactive checks when needed.

### Crop Semantics (Copy-on-Crop)
`crop()` allocates a new buffer containing the cropped region. This is intentionally **not** a zero-copy view.

**Rationale:**
- Simpler memory lifecycle — parent frames can be evicted independently of crops.
- Better cache locality — cropped data is contiguous for downstream OCR/CV.
- Crop sizes are small (typical ROIs are sub-megabyte); copy overhead is negligible compared to OCR latency.
- Leaves a clear optimization seam: swap to zero-copy views behind the same handle API if profiling shows crop overhead matters.

**Cropped handle lifecycle:**
- Crops are **not** in the ring buffer — no automatic eviction.
- Caller must `release()` cropped handles explicitly when done.
- Crops support `pin()`/`release()` like frame handles.
- The pipeline releases cropped handles after adapter execution completes.

---

## 4.1. TemplateStore

CV template matching jobs require reference images to match against. The `TemplateStore` manages these templates separately from the frame ring buffer. It's passed to the **CV adapter** (not the pipeline directly) — template management is a CV engine concern.

### Principles
- Templates are **persistent** — no automatic eviction.
- Templates are keyed by **string ID** (referenced by `CVJobConfig.templateID`).
- Templates can be loaded from files or created from captured frames.

### Interface
```ts
interface TemplateStore {
  register(id: string, image: Uint8Array, meta?: { width: number; height: number }): void;
  get(id: string): Uint8Array | null;
  has(id: string): boolean;
  remove(id: string): void;
  list(): string[];
}

function createTemplateStore(): TemplateStore;
```

> **Note:** Templates are stored as raw bytes rather than `FrameHandle` since they don't participate in the frame lifecycle (no pin/release, no eviction). The CV engine wrapper (`@sear/opencvjs`) handles conversion to the format needed for `cv.matchTemplate()`. Dimensions can be inferred from image bytes if `meta` is omitted.

### Usage
```ts
// loadImage: user-provided utility, e.g. (path: string) => Promise<Uint8Array>
// At app init or profile load
templateStore.register('health-icon', await loadImage('./templates/health.png'));
templateStore.register('mana-icon', await loadImage('./templates/mana.png'));

// In job config
const job: CVJobConfig = {
  type: 'cv',
  method: 'template',
  templateID: 'health-icon', // References registered template
  threshold: 0.8,
  // ...
};
```

---

## 4.2. Engine Adapters

The pipeline delegates OCR and CV execution to **adapters**. This decouples the pipeline from specific engine implementations and allows engines to manage their own concerns (WASM loading, template storage, etc.).

### Adapter Interfaces

```ts
interface PreprocessorAdapter {
  run(image: Uint8Array, steps: PreprocessorPipeline): Promise<Uint8Array>;
}

interface OCRAdapter {
  run(image: Uint8Array, config: Omit<OCRJobConfig, 'id' | 'roi' | 'schedule' | 'preprocess'>): Promise<OCRJobResult>;
}

interface CVAdapter {
  run(image: Uint8Array, config: Omit<CVJobConfig, 'id' | 'roi' | 'schedule' | 'preprocess'>): Promise<CVJobResult>;
}
```

> **Execution flow:** Pipeline crops the frame → preprocessor applies steps → adapter runs OCR/CV on preprocessed bytes. If `preprocess` is an empty array `[]`, the preprocessor is skipped entirely and cropped bytes are passed directly to the adapter.

> **Threading model:**
> - The **scheduler runs on the main thread** and coordinates all work. It's the single point of control.
> - **Adapters may run concurrently** — multiple OCR/CV jobs can be in-flight simultaneously if the adapter uses workers.
> - **Frame data is copied** to workers via `postMessage` (structured clone). Workers receive `Uint8Array` bytes, not handles.
> - **FrameStore is main-thread only** — workers don't access it directly. The scheduler reads bytes via `readBytes()` before dispatching to adapters.
> - Heavy work (preprocessing, OCR, template matching) should run in Web Workers to avoid blocking UI and scheduler.

### v0 Implementations

```ts
// @sear/sharp-preprocess (or @sear/opencv-preprocess)
function createSharpPreprocessor(): PreprocessorAdapter;

// @sear/tesseractjs
function createTesseractAdapter(config?: {
  // Future: language, engineMode, etc.
}): OCRAdapter;

// @sear/opencvjs
function createOpenCVAdapter(config: {
  templateStore: TemplateStore;  // CV adapter owns template management
}): CVAdapter;
```

### Usage

```ts
// loadImage: user-provided utility (see Section 4.1)
const templateStore = createTemplateStore();
templateStore.register('health-icon', await loadImage('./templates/health.png'));

const pipeline = createPipeline({
  telemetry: createTelemetry(),
  capture,
  store,
  preprocessor: createSharpPreprocessor(),
  ocr: createTesseractAdapter(),
  cv: createOpenCVAdapter({ templateStore }),
}).build();
```

> **Note:** Adapters handle their own initialization (WASM loading, worker setup). The pipeline calls `adapter.run()` with the preprocessed image bytes and job-specific config.

---

## 5. Pipeline & Scheduling

### Job-Driven Model
Jobs describe:
- ROI spec
- schedule
- desired analysis (OCR / CV / preprocess)

### Scheduler Timing
The scheduler runs on a **fixed interval** (configurable via `tickIntervalMs`, default 50ms = 20Hz). Each tick:
1. Grabs the latest frame from capture
2. Checks which jobs are due
3. Dispatches due jobs (if not already running)

This decouples scheduler rate from capture rate:
- Capture can run at 60fps for smooth preview
- Scheduler samples at a controlled rate (e.g., 20Hz) for predictable CPU usage
- Easier backpressure control — tune tick rate independent of capture

> **Future:** Per-job scheduler config could allow finer control (e.g., heavy jobs at 5Hz, light jobs at 30Hz).

### Scheduling Rules
- Capture runs independently at its own rate.
- Scheduler runs on fixed interval, grabs **latest available frame** each tick.
- **One in-flight execution per job**.
- If a job is due while still running → skip (do not queue).

### Pseudocode Scheduler Loop
```ts
const latestFrame = capture.getLatestFrame();

// No frame available — capture not started, or between frames
if (!latestFrame) return;

for (const job of jobs) {
  if (job.running) continue;
  if (!job.isDue(now)) continue;

  job.running = true;
  store.pin(latestFrame);
  runJob(job, latestFrame)
    .catch((err) => {
      job.lastError = { error: err, ts: Date.now() };
      telemetry.emit({ type: 'job.error', jobID: job.id, error: err });
    })
    .finally(() => {
      store.release(latestFrame);
      job.running = false;
    });
}
```

> **Note:** `getLatestFrame()` returns `null` when capture hasn't started or no frame has been acquired yet. The scheduler simply skips the tick — jobs will run once frames are available.

### Error Handling (v0)
```ts
type JobErrorState = {
  lastError: { error: Error; ts: number };
  errorHistory: Array<{ error: Error; ts: number }>; // Bounded, e.g., last 10
  consecutiveErrors: number; // Reset to 0 on successful run
};
```

- On error, job emits telemetry, appends to `errorHistory`, updates `lastError`, increments `consecutiveErrors`.
- On success, `consecutiveErrors` resets to 0.
- Job remains eligible to run on the next tick — no automatic backoff or disabling.
- Inspector displays error state for debugging.
- **Future:** Configurable retry policies (backoff, circuit breaker) per job.

### Runtime Job Type

The scheduler works with runtime `Job` objects that combine config with runtime state. (See Section 7.1 for `JobConfig` and `DynamicJobConfig` definitions.)

```ts
type JobRuntimeState = {
  running: boolean;
  lastRunTs?: number;
  lastError?: { error: Error; ts: number };
  errorHistory: Array<{ error: Error; ts: number }>;
  consecutiveErrors: number;
};

type Job = JobConfig & JobRuntimeState;

type DynamicJob = DynamicJobConfig & JobRuntimeState & {
  expiresAt: number; // computed from ttlMs on upsert/refresh
};
```

### Schedule Evaluation

`isJobDue` is a **pure function** (keeps jobs as serializable data for inspector/debugging):

```ts
import { match } from 'ts-pattern';

function isJobDue(job: Job, now: number): boolean {
  if (job.running) return false;
  if (!job.lastRunTs) return true; // never run

  return match(job.schedule)
    .with({ type: 'interval' }, (s) => now - job.lastRunTs! >= s.everyMs)
    .with({ type: 'everyTick' }, () => true)
    .exhaustive();
}
```

> **Note:** Use `ts-pattern` for discriminated union matching — provides exhaustiveness checking and cleaner syntax than switch statements.

---

## 6. ROI Model

### ROI Specs (Declarative)
```ts
type ROIConfig =
  | { kind: 'px'; x: number; y: number; width: number; height: number }
  | { kind: 'norm'; x: number; y: number; width: number; height: number }
  | { kind: 'anchor'; anchor: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'; dx: number; dy: number; width: number; height: number };

type ROIPx = { x: number; y: number; width: number; height: number };
```

> **Anchor `dx`/`dy` semantics:** Offsets are in standard screen coordinates (positive x = right, positive y = down) from the anchor point. For a `bottomRight` anchor, `dx: -200, dy: -200` places the ROI 200px left and 200px up from the bottom-right corner.

ROIs are resolved centrally by the pipeline using the current CaptureContext.

### ROI Resolution
```ts
function resolveROI(spec: ROIConfig, ctx: CaptureContext): ROIPx { ... }
```

### Calibration
- Inspector allows drawing ROIs visually.
- ROIs saved as normalized or anchored specs.
- Profiles can be per-application or per-resolution.

---

## 7. Core Types

This section defines the primary type definitions used throughout the framework.

---

### 7.0. Common Types

```ts
import type { Opaque } from 'type-fest'; // npm: type-fest

// Branded types (prevent accidental misuse of raw primitives)
type FrameID = Opaque<number, 'FrameID'>;

// Callback types
type Unsubscribe = () => void;
type UnregisterJobFn = () => void;

// Registry
type JobRegistry = Record<string, JobConfig>;
```

---

### 7.1. Job Configuration

### Schedule Config
```ts
type ScheduleConfig =
  | { type: 'interval'; everyMs: number }
  | { type: 'everyTick' };
```

> **`everyTick` semantics:** Runs on every scheduler tick (controlled by `tickIntervalMs`), not every captured frame. At default 20Hz tick rate with 60fps capture, `everyTick` jobs run ~20 times/sec, sampling whatever frame is latest at each tick.

> **Future consideration:** `{ type: 'onDemand' }` scheduling — jobs triggered explicitly rather than on interval/frame. Useful for user-initiated actions or event-driven analysis.

### Preprocess Pipeline
```ts
type PreprocessStep =
  | { type: 'grayscale' }
  | { type: 'resize'; scale: number }
  | { type: 'threshold'; value: number }
  | { type: 'threshold.adaptive'; blockSize: number; constant: number }
  | { type: 'invert' }
  | { type: 'denoise'; strength?: number }
  | { type: 'pad'; pixels: number };

type PreprocessorPipeline = PreprocessStep[];
```

> **Note:** A `@sear/utils` package will provide factory functions like `createLightTextPreprocessor()` for common presets.

### OCR & CV Engines (v0)

| Concern | Engine | Package | Notes |
|---------|--------|---------|-------|
| **OCR** | Tesseract.js | `@sear/tesseractjs` | Exports `createTesseractAdapter()` |
| **CV** | OpenCV.js | `@sear/opencvjs` | Exports `createOpenCVAdapter()`, uses `cv.matchTemplate()` |

Each package wraps its engine and exports an **adapter factory** (see Section 4.2). Adapters provide:
- Minimal, focused APIs implementing `OCRAdapter` or `CVAdapter`
- WASM loading and initialization handling
- TypeScript types
- Clear seam for future optimization (swap to native/Rust if needed)

Both avoid native addon complexity and work in Electron without build toolchain issues.

### Job Config (Discriminated Union)
```ts
type BaseJobConfig = {
  id: string;
  roi: ROIConfig;
  schedule: ScheduleConfig;
  preprocess: PreprocessorPipeline; // Required, use [] if no preprocessing needed
};

type OCRJobConfig = BaseJobConfig & {
  type: 'ocr';
  // v0: empty — future: lang, whitelist, engineMode, etc.
};

type CVJobConfig = BaseJobConfig & (
  | { type: 'cv'; method: 'template'; templateID: string; threshold?: number }
  | { type: 'cv'; method: 'model'; modelID: string; confidenceThreshold?: number; labels?: string[] }
);

type JobConfig = OCRJobConfig | CVJobConfig;
```

> **Note:** CVConfig uses `method` as its inner discriminant to avoid collision with the job's `type` field. v0 focuses on **template matching**; model-based detection is deferred.

### Dynamic Job Config
```ts
type DynamicOCRJobConfig = OCRJobConfig & {
  owner: string;
  ttlMs: number;
};

type DynamicCVJobConfig = CVJobConfig & {
  owner: string;
  ttlMs: number;
};

type DynamicJobConfig = DynamicOCRJobConfig | DynamicCVJobConfig;
```

---

### 7.2. Job Results

Results mirror the job structure as a discriminated union, with result properties flattened onto the root.

```ts
type BaseJobResult = {
  jobID: string;
  frame: FrameHandle;
  preprocessedFrame?: FrameHandle;
};

type OCRJobResult = BaseJobResult & {
  type: 'ocr';
  text: string;
  confidence?: number;
};

type BBox = { x: number; y: number; width: number; height: number };

type Detection = {
  id: string;      // Format: `${templateID}-${matchIndex}` — unique within a single result, not stable across frames
  label: string;   // The templateID that matched
  bbox: BBox;
  confidence?: number;
};

type CVJobResult = BaseJobResult & {
  type: 'cv';
  detections: Detection[];
};

type JobResult = OCRJobResult | CVJobResult;
```

> **`preprocessedFrame` lifecycle:** The pipeline owns preprocessed frame handles and releases them after all `onAnalysisTick` callbacks complete. Consumers can read the handle during the tick callback (e.g., for debugging/inspector display) but should not hold references beyond the callback.

---

### 7.3. Analysis Tick (Generic Typing)

The `AnalysisTick` type is generic over the job registry, enabling **end-to-end type inference** from job IDs to result types.

```ts
type ResultForJob<J extends JobConfig> =
  J extends OCRJobConfig ? OCRJobResult :
  J extends CVJobConfig ? CVJobResult :
  never;

interface AnalysisTick<Jobs extends JobRegistry> {
  ts: number; // performance.now()
  dt: number; // ms since last tick
  frame: FrameHandle;

  // Raw results array — use for iteration or debugging
  results: JobResult[];

  // Typed lookup over `results` — returns narrowed type based on job's config
  byJobID<K extends keyof Jobs>(jobID: K): ResultForJob<Jobs[K]> | undefined;
}
```

### Usage Example
```ts
const jobs = {
  'health-text': {
    type: 'ocr',
    id: 'health-text',
    roi: { kind: 'px', x: 100, y: 50, width: 200, height: 30 },
    schedule: { type: 'interval', everyMs: 100 },
    preprocess: [],
  },
  'minimap-icons': {
    type: 'cv',
    method: 'template',
    id: 'minimap-icons',
    templateID: 'icon-set',
    roi: { kind: 'anchor', anchor: 'bottomRight', dx: -200, dy: -200, width: 200, height: 200 },
    schedule: { type: 'interval', everyMs: 500 },
    preprocess: [],
  },
} as const satisfies Record<string, JobConfig>;


pipeline.onAnalysisTick((tick) => {
  const health = tick.byJobID('health-text');
  //    ^? OCRJobResult | undefined
  if (health) {
    console.log(health.text);
  }

  const icons = tick.byJobID('minimap-icons');
  //    ^? CVJobResult | undefined
  if (icons) {
    for (const d of icons.detections) { ... }
  }
});
```

---

### 7.4. Domain Events

```ts
type DomainEvent<T extends string = string, D = unknown> = {
  type: T;
  ts: number; // performance.now(), auto-populated on emit
  data: D;
};
```

Modules define their event types:
```ts
type HealthEvents =
  | DomainEvent<'health.updated', { current: number; max: number }>
  | DomainEvent<'health.critical', { current: number }>;

type CooldownEvents =
  | DomainEvent<'cooldown.started', { abilityID: string; durationMs: number }>
  | DomainEvent<'cooldown.ready', { abilityID: string }>;

// App-level union
type AllDomainEvents = HealthEvents | CooldownEvents;
```

Event types are accumulated via `withModule()` (see Section 9 for the builder pattern):
```ts
// After building with modules, the pipeline is typed with all events
pipeline.onDomainEvent((event) => {
  if (event.type === 'health.updated') {
    event.data.current; // TypeScript knows shape
  }
});
```

---

### 7.5. Pipeline Interface

```ts
// Builder for constructing pipelines with accumulated module types
interface PipelineBuilder<
  Jobs extends JobRegistry = {},
  Events extends DomainEvent = never
> {
  withModule<J extends JobRegistry, E extends DomainEvent>(
    module: ModuleDefinition<J, E>
  ): PipelineBuilder<Jobs & J, Events | E>;

  build(): Pipeline<Jobs, Events>;
}

function createPipeline(config: {
  telemetry: Telemetry;
  capture: Capture;
  store: FrameStore;
  preprocessor: PreprocessorAdapter;
  ocr: OCRAdapter;
  cv: CVAdapter;
  tickIntervalMs?: number; // Default: 50 (20Hz)
}): PipelineBuilder;

// Final pipeline with accumulated types from all modules
interface Pipeline<
  Jobs extends JobRegistry = JobRegistry,
  Events extends DomainEvent = DomainEvent
> {
  // Dynamic job management (static jobs registered via modules)
  dynamic: {
    upsert(config: DynamicJobConfig): void;
    clear(jobID: string): void;
    clearOwner(owner: string): void;
  };

  // Analysis hooks
  onAnalysisTick(callback: (tick: AnalysisTick<Jobs>) => void): Unsubscribe;

  // Domain events
  onDomainEvent(callback: (event: Events) => void): Unsubscribe;

  // Telemetry (reference to injected subsystem)
  readonly telemetry: Telemetry;

  // Debugging
  getState(): PipelineState;

  // Lifecycle
  start(): void;  // Start the scheduler loop
  stop(): void;   // Pause the scheduler loop (can restart)
  close(): void;  // Stop and release all resources (cannot restart)
}
```

> **Note:** Static jobs are registered via modules during `withModule()`. The final `Pipeline` interface exposes consumption APIs (events, ticks) and dynamic job management, but not static job registration.

> **Lifecycle:** Call `start()` after setting up subscribers to begin the scheduler loop. Use `stop()` to pause temporarily (e.g., when app is backgrounded). Call `close()` on shutdown to release resources and call module cleanup functions.

> **In-flight jobs on `stop()`:** Calling `stop()` prevents new ticks from being scheduled, but in-flight jobs are allowed to complete and their results are still emitted. No cancellation or abort logic.

---

### 7.6. Pipeline State & Metrics

```ts
type JobState = {
  id: string;
  type: 'ocr' | 'cv';
  running: boolean;
  lastError?: { error: Error; ts: number };
  consecutiveErrors: number;
  lastRunTs?: number;
};

type DynamicJobState = JobState & {
  owner: string;
  ttlMs: number;
  expiresAt: number;
};

type PipelineMetrics = {
  // Timing
  uptimeMs: number;
  startedAt: number;

  // Tick stats
  tickCount: number;
  tickRate: number; // ticks/sec (rolling average)
  avgTickDurationMs: number;
  lastTickTs: number;

  // Frame stats
  framesCaptured: number;
  frameRate: number; // FPS (rolling average)
  framesInStore: number;
  framesPinned: number;
  framesEvicted: number;

  // Job stats
  jobsExecuted: number;
  jobsSkipped: number;
  jobErrors: number;
  avgJobDurationMs: Record<string, number>; // by jobID

  // Dynamic jobs (created = first-time only, not refreshes)
  dynamicJobsCreated: number;
  dynamicJobsExpired: number;
  dynamicJobsCleared: number;
};

type PipelineState = {
  jobs: JobState[];
  dynamicJobs: DynamicJobState[];
  captureContext: CaptureContext | null;
  moduleIDs: string[];
  metrics: PipelineMetrics;
};
```

---

## 8. CV → OCR Chaining (Dynamic ROIs)

### Problem
Some UI elements:
- Move relative to the window contents.
- Must be detected visually before OCR.

### Solution
- CV jobs emit **detections** with bounding boxes (see `Detection` type in Section 7.2).
- Detections spawn **dynamic OCR jobs** whose ROIs track the detected bbox.

### Utility: `getROIFromBBox`
```ts
function getROIFromBBox(bbox: BBox): ROIConfig {
  return { kind: 'px', ...bbox };
}
```

Converts a CV detection bounding box to an ROI config for spawning dynamic jobs.

### Dynamic Job API (Conceptual)
```ts
// Create or refresh a dynamic OCR job (called from within a module's install())
ctx.dynamic.upsert({
  type: 'ocr',
  id: 'detected:123:text',
  // owner auto-injected from module id
  roi: getROIFromBBox(detection.bbox),
  schedule: { type: 'interval', everyMs: 150 },
  preprocess: [],
  ttlMs: 500,
});

// Immediate removal
pipeline.dynamic.clear(jobID);
pipeline.dynamic.clearOwner(owner);
```

### Dynamic Job Lifecycle
- **Upsert semantics:** `upsert()` is a true upsert — if the job exists, **all config fields are replaced** (ROI, schedule, preprocess, etc.) and `expiresAt` is reset. This supports tracking moving elements where the ROI changes each frame.
- **TTL expiry:** Jobs expire automatically if not refreshed within `ttlMs`. Safety net for orphaned jobs.
- **Explicit clear:** `clear(jobID)` or `clearOwner(owner)` for immediate removal when a module knows it's done tracking.
- **Expiry during execution:** If a job expires while running, it's allowed to complete — expiry only prevents future scheduling. The result is still emitted. No mid-execution cancellation.

---

## 9. Modules

### Module Responsibilities
- Register jobs (static and dynamic).
- Maintain state across ticks.
- Interpret OCR/CV results into **domain events**.

### Module Definition

Modules are defined using `defineModule<Jobs, Events>()`, which provides **full type inference** for job results and domain events within the module:

```ts
type Cleanup = () => void;

// ModuleContext is created by the pipeline for each module, with the module's id
// closure-captured. This enables auto-injection of owner and ts fields.
interface ModuleContext<Jobs extends JobRegistry, Events extends DomainEvent> {
  registerJob<K extends keyof Jobs & string>(config: Jobs[K] & { id: K }): UnregisterJobFn;
  onAnalysisTick(callback: (tick: AnalysisTick<Jobs>) => void): Unsubscribe;
  emitDomainEvent(event: Omit<Events, 'ts'>): void; // ts auto-populated
  dynamic: {
    upsert(config: Omit<DynamicJobConfig, 'owner'>): void; // owner auto-injected from module id
    clear(jobID: string): void;
    clearOwner(owner: string): void;
  };
}

interface ModuleDefinition<Jobs extends JobRegistry, Events extends DomainEvent> {
  id: string;
  _jobs?: Jobs;    // Phantom type for inference
  _events?: Events; // Phantom type for inference
  install(ctx: ModuleContext<Jobs, Events>): Cleanup;
}

function defineModule<Jobs extends JobRegistry, Events extends DomainEvent>(
  id: string,
  install: (ctx: ModuleContext<Jobs, Events>) => Cleanup
): ModuleDefinition<Jobs, Events>;
```

### Module Lifecycle (v0)
- `install()` returns a cleanup function for releasing resources (listeners, timers, dynamic jobs).
- `pipeline.withModule(module)` registers the module and accumulates its types.
- `pipeline.close()` calls all cleanup functions — wire this into app shutdown.
- **Needs exploration:** Hot-reload DX. Unclear if cleanup/reinstall is the right pattern or if a different approach (state preservation, HMR-style patching) is better. High priority to investigate.

### Pipeline Builder (Type Aggregation)

The pipeline builder accumulates types from all registered modules:

```ts
const pipeline = createPipeline({ telemetry, capture, store, preprocessor, ocr, cv })
  .withModule(healthModule)     // Adds HealthJobs, HealthEvents
  .withModule(cooldownModule)   // Adds CooldownJobs, CooldownEvents
  .build();

// Pipeline type is now:
// Pipeline<HealthJobs & CooldownJobs, HealthEvents | CooldownEvents>

// Consumers get fully typed events
pipeline.onDomainEvent((event) => {
  if (event.type === 'health.updated') {
    event.data.current; // TypeScript knows shape
  }
});
```

### Example Module (Health Tracker)

```ts
// Define module's job and event types
type HealthJobs = {
  'health-ocr': OCRJobConfig;
};

type HealthEvents =
  | DomainEvent<'health.updated', { current: number; max: number }>
  | DomainEvent<'health.critical', { current: number }>;

// createStableTextTracker: User-provided utility for debouncing noisy OCR text.
// Tracks text per key, returns { text } only after it's been unchanged for minMs.
// Example signature (not framework-provided):
function createStableTextTracker(): (
  key: string,
  text: string,
  dtMs: number,
  opts: { minMs: number }
) => { text: string } | null;

// Define the module with explicit generics
const healthModule = defineModule<HealthJobs, HealthEvents>(
  'health',
  (ctx) => {
    const stableText = createStableTextTracker();

    const unregisterJob = ctx.registerJob({
      id: 'health-ocr',
      type: 'ocr',
      roi: { kind: 'px', x: 100, y: 50, width: 200, height: 30 },
      schedule: { type: 'interval', everyMs: 100 },
      preprocess: [],
    });

    const unsubTick = ctx.onAnalysisTick((tick) => {
      const res = tick.byJobID('health-ocr');
      //    ^? OCRJobResult | undefined — typed as OCR (not union), still needs undefined check

      if (!res) return;

      const stable = stableText('health', res.text, tick.dt, { minMs: 300 });
      if (!stable) return;

      // parseHealth: user-provided, e.g. (text: string) => { current: number; max: number } | null
      const parsed = parseHealth(stable.text);
      if (parsed) {
        ctx.emitDomainEvent({
          type: 'health.updated',
          data: parsed,
        }); // ts auto-populated by emitDomainEvent
      }
    });

    return () => {
      unsubTick();
      unregisterJob();
    };
  }
);
```

---

## 10. Telemetry & Observability

### Telemetry Goals
- Explain incorrect detection.
- Explain performance issues.
- Power inspector UI and replay.

### Telemetry Subsystem

Telemetry is a **separate top-level subsystem**, injected into Pipeline. Consumers can subscribe directly without a Pipeline reference.

```ts
interface Telemetry {
  emit(event: TelemetryEvent): void;
  on(callback: (event: TelemetryEvent) => void): Unsubscribe;
}

function createTelemetry(): Telemetry;

// Usage at app init
const telemetry = createTelemetry();
const pipeline = createPipeline({ telemetry, capture, store, preprocessor, ocr, cv }).build();

// Inspector subscribes directly
telemetry.on((event) => updateDashboard(event));
```

### Telemetry Event Types

```ts
interface TelemetryEventBase {
  ts: number; // performance.now() — monotonic, sub-ms precision
}

// Job execution timing
interface TimingEvent extends TelemetryEventBase {
  type: 'timing';
  frame: FrameHandle;
  jobID: string;
  stage: 'crop' | 'preprocess' | 'ocr' | 'cv';
  ms: number;
}

// Job error
interface JobErrorEvent extends TelemetryEventBase {
  type: 'job.error';
  jobID: string;
  error: Error;
}

// Job skipped (due while still running)
interface JobSkippedEvent extends TelemetryEventBase {
  type: 'job.skipped';
  jobID: string;
  reason: 'already_running';
}

// Frame lifecycle
interface FrameCapturedEvent extends TelemetryEventBase {
  type: 'frame.captured';
  frame: FrameHandle;
  width: number;
  height: number;
}

interface FrameEvictedEvent extends TelemetryEventBase {
  type: 'frame.evicted';
  frame: FrameHandle;
}

// Dynamic job lifecycle
interface DynamicJobEvent extends TelemetryEventBase {
  type: 'dynamic.created' | 'dynamic.refreshed' | 'dynamic.expired' | 'dynamic.cleared';
  jobID: string;
  owner: string;
}

// Capture context changed
interface CaptureContextChangedEvent extends TelemetryEventBase {
  type: 'capture.contextChanged';
  previous: CaptureContext | null;
  current: CaptureContext;
}

type TelemetryEvent =
  | TimingEvent
  | JobErrorEvent
  | JobSkippedEvent
  | FrameCapturedEvent
  | FrameEvictedEvent
  | DynamicJobEvent
  | CaptureContextChangedEvent;
```

### Telemetry Sinks
- Inspector UI (live)
- Recorder (file)
- Console (optional)

---

## 11. Inspector & Overlay

### `@sear/inspector` Package

The inspector is a standalone Electron app packaged as `@sear/inspector` — similar in spirit to **Storybook**. Developers fire it up to:

- **Inspect recordings** — Load and scrub through captured sessions
- **Live preview** — See pipeline output in real-time against a target window
- **Configure ROIs** — Draw and adjust regions visually, see OCR/CV results update immediately
- **Debug modules** — View domain events, telemetry, and job state
- **Iterate on preprocess pipelines** — Tweak parameters and see the effect on OCR accuracy

The inspector consumes the same Pipeline, Telemetry, and FrameStore APIs as any other consumer — it's a first-class reference implementation.

### Inspector UI Features
- Capture target selection + health indicators
- Live frame preview with ROI overlays
- Visual ROI editor (draw, resize, anchor)
- Telemetry dashboards (timing, errors, throughput)
- Recording & replay controls

### Overlay Window
- Transparent, always-on-top
- Click-through
- Draws ROIs, detections, labels

Overlay receives **geometry + draw commands**, not image bytes.

> **Note:** The full inspector architecture and UX will be covered in a separate design document.

---

### 11.1. React Integration Patterns

The Inspector UI uses React. Since Pipeline and Telemetry live outside React's scope, we need patterns to bridge domain events and telemetry into React's rendering model.

### Using `useSyncExternalStore` (React 18+)

```ts
import { useSyncExternalStore } from 'react';

// External state updated by pipeline events (managed outside React)
type GameState = {
  health: { current: number; max: number };
  cooldowns: Record<string, { abilityID: string; durationMs: number }>;
};
const gameState: GameState = { health: { current: 100, max: 100 }, cooldowns: {} };

function useDomainEvent<
  Jobs extends JobRegistry,
  Events extends DomainEvent,
  T
>(
  pipeline: Pipeline<Jobs, Events>,
  eventType: Events['type'],
  getSnapshot: () => T
): T {
  return useSyncExternalStore(
    (onStoreChange) => pipeline.onDomainEvent((e) => {
      if (e.type === eventType) onStoreChange();
    }),
    getSnapshot
  );
}

// Usage (assumes pipeline typed with HealthEvents)
function HealthBar() {
  const health = useDomainEvent(pipeline, 'health.updated', () => gameState.health);
  return <Bar value={health.current} max={health.max} />;
}
```

### Using Zustand (Recommended for Complex State)

```ts
import { create } from 'zustand';

// GameState type defined above (or import from shared types)
const useGameStore = create<GameState>((set) => ({
  health: { current: 100, max: 100 },
  cooldowns: {},
}));

// Bridge pipeline events to store (once at app init)
pipeline.onDomainEvent((event) => {
  switch (event.type) {
    case 'health.updated':
      useGameStore.setState({ health: event.data });
      break;
    case 'cooldown.started':
      useGameStore.setState((s) => ({
        cooldowns: { ...s.cooldowns, [event.data.abilityID]: event.data }
      }));
      break;
  }
});

// Components subscribe to slices
function HealthBar() {
  const health = useGameStore((s) => s.health);
  return <Bar value={health.current} max={health.max} />;
}

function CooldownIcon({ abilityID }: { abilityID: string }) {
  const cooldown = useGameStore((s) => s.cooldowns[abilityID]);
  return <Icon duration={cooldown?.durationMs} />;
}
```

### Telemetry Dashboard

```ts
// Telemetry can use the same patterns
// TelemetryState: user-defined based on what telemetry you want to surface in your UI
const useTelemetryStore = create<TelemetryState>((set) => ({
  recentEvents: [],
  metrics: null,
}));

telemetry.on((event) => {
  useTelemetryStore.setState((s) => ({
    recentEvents: [...s.recentEvents.slice(-99), event], // keep last 100
  }));
});

// For pipeline metrics, poll or subscribe
setInterval(() => {
  useTelemetryStore.setState({ metrics: pipeline.getState().metrics });
}, 1000);
```

Both patterns work. Zustand is recommended for the Inspector due to its simplicity with complex state and slice subscriptions.

---

## 12. Recording & Replay

Recording and replay are critical for debugging and iterating on OCR/CV configurations without needing live access to the target application.

### High-Level Goals
- **Recording:** Capture frame data (or ROI crops), telemetry events, and pipeline state over a session
- **Replay:** Re-run the pipeline against recorded data with deterministic execution
- **Inspector integration:** Timeline scrubbing, frame-by-frame stepping, side-by-side comparison of config changes

### Conceptual Flow
1. User starts recording in inspector
2. Frames, job results, and telemetry are serialized to disk
3. User loads recording later (or shares with team)
4. Pipeline replays against recorded frames — no live capture needed
5. User tweaks ROIs, preprocess steps, or module logic and sees updated results

> **Deferred:** Recording file format, storage APIs, replay determinism guarantees, and inspector UX will be specified in a **separate technical design document**. This is a substantial subsystem that warrants its own detailed treatment.

---

## 13. v0 Scope Summary

### Included
- Windows
- Electron host
- Main-process pipeline
- Window capture + display fallback
- Static & dynamic ROIs
- OCR + CV jobs
- Inspector + overlay
- Recording & replay

### Deferred
- Injection-based overlays
- Cross-platform support
- Advanced CV anchoring
- Distributed telemetry

---

## 14. Risks & Mitigations

| Risk | Mitigation |
|-----|-----------|
| Capture blocked | Display fallback |
| DPI scaling bugs | CaptureContext as source of truth |
| OCR noise | Stability utilities |
| Perf spikes | Backpressure + skipping |
| Architecture lock-in | Adapter boundaries |

---

## 15. Guiding Principles

- DX first
- Handles, not buffers
- Drop work, don’t queue
- Declarative specs, centralized resolution
- Inspector as first-class consumer
