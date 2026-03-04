import "dotenv/config";
import http from "http";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { analyzeMarkedScreenshot, type GeminiVerdict } from "./agent";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const PORT = Number(process.env["PORT"] ?? 3001);
const ALLOWED_ORIGIN = process.env["ALLOWED_ORIGIN"] ?? "http://localhost:3000";
const PLAYWRIGHT_HEADLESS = process.env["PLAYWRIGHT_HEADLESS"] !== "false";
const DEFAULT_URL = process.env["DEFAULT_URL"] ?? "http://localhost:3002";

// ---------------------------------------------------------------------------
// Message protocol — inbound from frontend
// ---------------------------------------------------------------------------
interface CaptureMessage {
  type: "capture";
}

interface ActionClickMessage {
  type: "action";
  action: "click";
  x: number;
  y: number;
}

interface ActionTypeMessage {
  type: "action";
  action: "type";
  /** Exact string to type */
  text: string;
  /** Center X of the target element — used to click-focus before typing */
  x: number;
  /** Center Y of the target element — used to click-focus before typing */
  y: number;
}

interface ActionNavigateMessage {
  type: "action";
  action: "navigate";
  url: string;
}

interface ActionScrollMessage {
  type: "action";
  action: "scroll";
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
}

interface InitMessage {
  type: "init";
  /** URL to navigate the browser session to */
  url: string;
}

interface AnalyzeMessage {
  type: "analyze";
  /** Natural language description of the goal to accomplish */
  objective: string;
}

type InboundMessage =
  | CaptureMessage
  | ActionClickMessage
  | ActionTypeMessage
  | ActionNavigateMessage
  | ActionScrollMessage
  | InitMessage
  | AnalyzeMessage;

// ---------------------------------------------------------------------------
// Message protocol — outbound to frontend
// ---------------------------------------------------------------------------
interface CaptureResult {
  type: "capture_result";
  /** Base64-encoded PNG of the current page state */
  imageBase64: string;
  url: string;
  timestamp: number;
}

interface ActionAck {
  type: "action_ack";
  action: string;
  timestamp: number;
}

interface SessionReady {
  type: "session_ready";
  url: string;
  timestamp: number;
}

/**
 * Wire-protocol shape sent to the frontend for every analyze cycle.
 * Coordinates here are RESOLVED from the element map, not guessed.
 */
interface WireQaAction {
  action_type: string;
  x_coordinate: number; // resolved from ElementMark.centerX
  y_coordinate: number; // resolved from ElementMark.centerY
  target_id: number; // the badge ID Gemini selected
  input_text: string;
  is_error_state: boolean;
  task_status: "in_progress" | "completed" | "failed";
  reasoning: string;
}

interface AnalyzeResult {
  type: "analyze_result";
  action: WireQaAction;
  objective: string;
  timestamp: number;
}

interface ErrorResult {
  type: "error";
  message: string;
  code: string;
}

type OutboundMessage =
  | CaptureResult
  | ActionAck
  | SessionReady
  | AnalyzeResult
  | ErrorResult;

function send(socket: WebSocket, payload: OutboundMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Playwright — persistent singleton browser (shared across all sessions)
// ---------------------------------------------------------------------------
let browser: Browser | null = null;

async function launchBrowser(): Promise<Browser> {
  console.log("[playwright] Launching persistent Chromium instance...");
  const instance = await chromium.launch({
    headless: PLAYWRIGHT_HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // Docker /dev/shm is only 64MB by default
      "--disable-gpu", // No GPU in Cloud Run containers
      "--disable-blink-features=AutomationControlled",
    ],
  });
  console.log(`[playwright] Browser ready. Headless: ${PLAYWRIGHT_HEADLESS}`);
  return instance;
}

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await launchBrowser();
  }
  return browser;
}

// ---------------------------------------------------------------------------
// Session — one BrowserContext + one Page per WebSocket connection.
// The page is NEVER closed between messages. It stays alive for the full
// duration of the WS connection so cookies, DOM state, and navigation
// history are preserved across every action and capture round-trip.
// ---------------------------------------------------------------------------
interface Session {
  context: BrowserContext;
  page: Page;
}

async function createSession(): Promise<Session> {
  const b = await getBrowser();
  // Isolated context per client: separate cookies, localStorage, cache
  const context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  return { context, page };
}

async function destroySession(session: Session): Promise<void> {
  try {
    await session.page.close();
    await session.context.close();
  } catch {
    // Ignore errors during teardown — connection may already be dead
  }
}

// ---------------------------------------------------------------------------
// Set-of-Mark helpers
// ---------------------------------------------------------------------------

/** One interactive element found on the page */
interface ElementMark {
  id: number;
  centerX: number;
  centerY: number;
  tag: string;
}

/**
 * Inject visual bounding boxes + numbered red badges into the live page.
 * Returns the element map so the backend can resolve badge IDs → coordinates.
 * All injected DOM nodes carry data-prism-* attributes for easy cleanup.
 */
async function injectMarks(page: Page): Promise<ElementMark[]> {
  return page.evaluate(
    (): { id: number; centerX: number; centerY: number; tag: string }[] => {
      const SELECTORS = [
        "input",
        "button",
        "a",
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="option"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '[role="listitem"]',
        '[role="combobox"]',
        '[role="tab"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(", ");
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(SELECTORS),
      );
      const marks: {
        id: number;
        centerX: number;
        centerY: number;
        tag: string;
      }[] = [];
      let id = 1;

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const cs = window.getComputedStyle(el);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          parseFloat(cs.opacity) === 0
        )
          continue;

        // Mark the element itself — use setProperty with !important so the
        // outline punches through React portal z-stacking contexts.
        el.setAttribute("data-prism-id", String(id));
        el.style.setProperty("outline", "2px solid #ff0000", "important");
        el.style.setProperty("outline-offset", "1px", "important");
        el.style.setProperty("position", "relative", "important"); // establish stacking context
        el.style.setProperty("z-index", "999998", "important"); // sit below only our badge

        // Create the numeric badge
        const badge = document.createElement("div");
        badge.setAttribute("data-prism-badge", "true");
        badge.style.cssText = [
          "position:fixed",
          `left:${Math.round(rect.left)}px`,
          `top:${Math.round(rect.top)}px`,
          "background:#ff0000",
          "color:#ffffff",
          "font-size:10px",
          "font-weight:700",
          "font-family:monospace",
          "line-height:1",
          "padding:2px 4px",
          "z-index:2147483647",
          "pointer-events:none",
          "letter-spacing:0",
        ].join(";");
        badge.textContent = String(id);
        document.body.appendChild(badge);

        marks.push({
          id,
          centerX: Math.round(rect.left + rect.width / 2),
          centerY: Math.round(rect.top + rect.height / 2),
          tag: el.tagName.toLowerCase(),
        });
        id++;
      }
      return marks;
    },
  );
}

/**
 * Remove all injected SoM overlays from the page so the next clean
 * screenshot has no visual artifacts.
 */
async function cleanupMarks(page: Page): Promise<void> {
  await page.evaluate(() => {
    document
      .querySelectorAll("[data-prism-badge]")
      .forEach((el) => el.remove());
    document.querySelectorAll<HTMLElement>("[data-prism-id]").forEach((el) => {
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
      el.style.removeProperty("position");
      el.style.removeProperty("z-index");
      el.removeAttribute("data-prism-id");
    });
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------
async function handleCapture(
  session: Session,
  socket: WebSocket,
): Promise<void> {
  const buffer = await session.page.screenshot({
    type: "png",
    fullPage: false,
  });
  send(socket, {
    type: "capture_result",
    imageBase64: buffer.toString("base64"),
    url: session.page.url(),
    timestamp: Date.now(),
  });
}

/**
 * Set-of-Mark analyze pipeline:
 * 1. Inject bounding-box overlays + numbered badges → get element map
 * 2. Screenshot the marked page
 * 3. Send marked screenshot + objective to Gemini
 * 4. Gemini returns target_id (badge number)
 * 5. Resolve target_id → precise center coordinates from element map
 * 6. Clean up all injected DOM nodes
 * 7. Send resolved WireQaAction to frontend
 */
async function handleAnalyze(
  msg: AnalyzeMessage,
  session: Session,
  socket: WebSocket,
  history: string[],
): Promise<void> {
  console.log(`[som] Injecting marks for: "${msg.objective}"`);

  // ── Step 1: inject visual anchors ──────────────────────────────────────
  const elementMap = await injectMarks(session.page);
  console.log(`[som] ${elementMap.length} interactive elements marked.`);

  // ── Step 2: screenshot WITH marks visible ──────────────────────────────
  const buffer = await session.page.screenshot({
    type: "png",
    fullPage: false,
  });
  const imageBase64 = buffer.toString("base64");

  // ── Step 3: ask Gemini to identify the badge ID ────────────────────────
  let verdict: GeminiVerdict;
  try {
    verdict = await analyzeMarkedScreenshot({
      imageBase64,
      objective: msg.objective,
      history,
    });
  } finally {
    // ── Step 6: always clean up, even on error ────────────────────────────
    await cleanupMarks(session.page);
  }

  console.log(
    `[som] Gemini → target_id: ${verdict.target_id}, ` +
      `action: ${verdict.action_type}, error: ${verdict.is_error_state}`,
  );

  // ── Step 4-5: resolve badge ID → precise center coordinates ───────────
  const mark = elementMap.find((m) => m.id === verdict.target_id);

  const resolvedX = mark?.centerX ?? 0;
  const resolvedY = mark?.centerY ?? 0;

  if (verdict.target_id >= 1 && !mark) {
    console.warn(
      `[som] target_id ${verdict.target_id} not found in element map ` +
        `(map has ${elementMap.length} entries). Defaulting to (0,0).`,
    );
  } else if (mark) {
    console.log(
      `[som] Resolved badge ${verdict.target_id} → <${mark.tag}> at (${resolvedX}, ${resolvedY})`,
    );
  }

  // ── Step 7: send resolved action to frontend ───────────────────────────
  const wireAction: WireQaAction = {
    action_type: verdict.action_type,
    x_coordinate: resolvedX,
    y_coordinate: resolvedY,
    target_id: verdict.target_id,
    input_text: verdict.input_text,
    is_error_state: verdict.is_error_state,
    task_status: verdict.task_status,
    reasoning: verdict.reasoning,
  };

  send(socket, {
    type: "analyze_result",
    action: wireAction,
    objective: msg.objective,
    timestamp: Date.now(),
  });
}

async function handleAction(
  msg: InboundMessage,
  session: Session,
  socket: WebSocket,
): Promise<void> {
  if (msg.type !== "action") return;

  switch (msg.action) {
    case "click": {
      await session.page.mouse.click(msg.x, msg.y);
      break;
    }
    case "type": {
      // Step 1: click the element to guarantee focus before typing.
      await session.page.mouse.click(msg.x, msg.y);
      // Step 2: brief pause for React/Vue controlled inputs to register the click.
      await session.page.waitForTimeout(80);
      // Step 3: type the text (for native <select>, this filters option text).
      await session.page.keyboard.type(msg.text);
      // Step 4: press Enter to lock in the selection (critical for native dropdowns).
      await session.page.keyboard.press("Enter");
      break;
    }
    case "navigate": {
      await session.page.goto(msg.url, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
      break;
    }
    case "scroll": {
      await session.page.mouse.wheel(msg.deltaX ?? 0, msg.deltaY ?? 0);
      break;
    }
  }

  send(socket, {
    type: "action_ack",
    action: msg.action,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Express — HTTP layer
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.use((_req: Request, res: Response, next: express.NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "prism-qa-backend",
    browserConnected: browser?.isConnected() ?? false,
    activeSessions: wss?.clients.size ?? 0,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket servers
// ---------------------------------------------------------------------------
const httpServer = http.createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket: WebSocket, req: http.IncomingMessage) => {
  const clientIp = req.socket.remoteAddress ?? "unknown";
  console.log(`[ws] Client connected from ${clientIp}`);

  // Per-connection state
  let session: Session | null = null;
  const sessionHistory: string[] = []; // short-term memory for the autonomous loop

  // ── Open Playwright session immediately — navigation deferred until init ──
  (async () => {
    try {
      session = await createSession();
      console.log(
        `[ws] Browser session created for ${clientIp}. Awaiting init URL from frontend...`,
      );
      // Signal WS is up and the browser process is alive. url="" means "not yet navigated".
      send(socket, { type: "session_ready", url: "", timestamp: Date.now() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ws] Session init failed: ${message}`);
      send(socket, { type: "error", message, code: "SESSION_INIT_FAILED" });
      socket.terminate();
    }
  })();

  // ── Route inbound messages ───────────────────────────────────────────────
  socket.on("message", async (rawData: RawData) => {
    if (!session) {
      send(socket, {
        type: "error",
        message: "Session not yet initialized.",
        code: "SESSION_NOT_READY",
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData.toString());
    } catch {
      send(socket, {
        type: "error",
        message: "Malformed JSON payload.",
        code: "PARSE_ERROR",
      });
      return;
    }

    const msg = parsed as InboundMessage;

    try {
      if (msg.type === "init") {
        // Navigate the browser to the user-supplied URL, then confirm ready.
        const targetUrl = msg.url.trim();
        console.log(`[ws] Received init. Navigating to ${targetUrl}...`);
        await session.page.goto(targetUrl, {
          waitUntil: "networkidle",
          timeout: 30_000,
        });
        const live = session.page.url();
        console.log(`[ws] Session ready at ${live}`);
        send(socket, {
          type: "session_ready",
          url: live,
          timestamp: Date.now(),
        });
      } else if (msg.type === "capture") {
        await handleCapture(session, socket);
      } else if (msg.type === "action") {
        // Record action in session memory before executing
        if (msg.action === "click") {
          sessionHistory.push(`Clicked at coordinates (${msg.x}, ${msg.y})`);
        } else if (msg.action === "type") {
          sessionHistory.push(
            `Typed "${msg.text}" into element at (${msg.x}, ${msg.y}) [target focused first]`,
          );
        } else if (msg.action === "navigate") {
          sessionHistory.push(`Navigated to ${msg.url}`);
        } else if (msg.action === "scroll") {
          sessionHistory.push(
            `Scrolled page (deltaX: ${msg.deltaX ?? 0}, deltaY: ${msg.deltaY ?? 0})`,
          );
        }
        await handleAction(msg, session, socket);
      } else if (msg.type === "analyze") {
        // Screenshot live page → Gemini → structured QA action
        await handleAnalyze(msg, session, socket, sessionHistory);
      } else {
        send(socket, {
          type: "error",
          message: `Unknown message type: "${String((msg as Record<string, unknown>)["type"])}"`,
          code: "UNKNOWN_TYPE",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ws] Handler error: ${message}`);
      send(socket, { type: "error", message, code: "HANDLER_ERROR" });
    }
  });

  // ── Tear down session ONLY when connection closes ────────────────────────
  socket.on("close", (code, reason) => {
    console.log(`[ws] Client disconnected (${code}) ${reason.toString()}`);
    if (session) {
      void destroySession(session).then(() => {
        console.log(`[ws] Session destroyed for ${clientIp}`);
      });
      session = null;
    }
  });

  socket.on("error", (err) => {
    console.error("[ws] Socket error:", err.message);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);
  wss.close(() => console.log("[ws] WebSocket server closed."));
  httpServer.close(() => console.log("[http] HTTP server closed."));
  if (browser) {
    await browser.close();
    console.log("[playwright] Browser closed.");
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // ── 1. Bind the port FIRST so Cloud Run health check passes immediately ──
  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("  Prism QA — Backend Server");
      console.log("  ─────────────────────────────────────────");
      console.log(`  HTTP  : http://0.0.0.0:${PORT}`);
      console.log(`  WS    : ws://0.0.0.0:${PORT}/ws`);
      console.log(`  Health: http://0.0.0.0:${PORT}/health`);
      console.log("  ─────────────────────────────────────────");
      console.log("  Launching browser...");
      console.log("");
      resolve();
    });
  });

  // ── 2. Launch Playwright after the port is open ──────────────────────────
  browser = await launchBrowser();
  console.log("  Browser ready. Waiting for frontend connection...");
}

main().catch((err: unknown) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
