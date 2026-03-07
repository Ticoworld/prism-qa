import "dotenv/config";
import http from "http";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
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
  /** Badge ID that was clicked (for session history so the agent does not repeat). */
  target_id?: number;
}

interface ActionTypeMessage {
  type: "action";
  action: "type";
  /** Exact string to type */
  text: string;
  /** Center X of the target element — used when target_id not resolved */
  x: number;
  /** Center Y of the target element — used when target_id not resolved */
  y: number;
  /** Badge ID for re-resolving current center at action time (avoids stale coords) */
  target_id?: number;
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
  /** When set, scroll by one viewport height (used by agent SCROLL action). */
  direction?: "up" | "down";
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
  /** When action_type is "scroll", "up" or "down". */
  scroll_direction?: "up" | "down";
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
  // Block web fonts to prevent screenshot hangs and reduce bandwidth
  await page.route("**/*.{woff,woff2,ttf,otf,eot}", (route) => route.abort());
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

/** One interactive element found on the page (main-viewport coordinates) */
interface ElementMark {
  id: number;
  centerX: number;
  centerY: number;
  tag: string;
}

const SOM_SELECTORS = [
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

/** Max frames to inject SoM into; ad-heavy pages (e.g. W3Schools) can have 200+ iframes. */
const MAX_FRAMES_FOR_SOM = 20;

/** Collect frames in deterministic order: main first, then children depth-first. */
function collectFrames(page: Page): Frame[] {
  const out: Frame[] = [];
  function walk(frame: Frame): void {
    out.push(frame);
    for (const child of frame.childFrames()) walk(child);
  }
  walk(page.mainFrame());
  return out.slice(0, MAX_FRAMES_FOR_SOM);
}

/** Per-frame injection: run inside a single frame. Returns marks (frame-relative coords) and nextId. */
async function injectMarksInFrame(
  frame: Frame,
  startId: number,
): Promise<{ marks: { id: number; centerX: number; centerY: number; tag: string }[]; nextId: number }> {
  return frame.evaluate(
    (arg: { sel: string; sid: number }) => {
      const { sel, sid } = arg;
      const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const marks: { id: number; centerX: number; centerY: number; tag: string }[] = [];
      let id = sid;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0)
          continue;
        el.setAttribute("data-prism-id", String(id));
        el.style.setProperty("outline", "2px solid #ff0000", "important");
        el.style.setProperty("outline-offset", "1px", "important");
        el.style.setProperty("position", "relative", "important");
        el.style.setProperty("z-index", "999998", "important");
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
      return { marks, nextId: id };
    },
    { sel: SOM_SELECTORS, sid: startId },
  );
}

/**
 * Inject visual bounding boxes + numbered red badges into the main page and all
 * same-origin iframes. Badge IDs are globally unique. Returns element map with
 * coordinates in main-page viewport (iframe elements offset by iframe rect).
 */
/**
 * Inject SoM into main frame and all same-origin iframes.
 * Cross-origin iframes are skipped (browser security); only same-origin embeds get badges.
 */
async function injectMarks(page: Page): Promise<ElementMark[]> {
  const frames = collectFrames(page);
  let globalBadgeCounter = 1;
  const elementMap: ElementMark[] = [];
  let framesInjected = 0;

  for (const frame of frames) {
    let offsetX = 0;
    let offsetY = 0;
    if (frame !== page.mainFrame()) {
      try {
        const frameEl = await frame.frameElement();
        if (frameEl) {
          const box = await frameEl.boundingBox();
          if (box) {
            offsetX = box.x;
            offsetY = box.y;
          }
        }
      } catch {
        continue;
      }
    }

    try {
      const { marks, nextId } = await injectMarksInFrame(frame, globalBadgeCounter);
      for (const m of marks) {
        elementMap.push({
          id: m.id,
          centerX: offsetX + m.centerX,
          centerY: offsetY + m.centerY,
          tag: m.tag,
        });
      }
      globalBadgeCounter = nextId;
      framesInjected++;
    } catch {
      // Cross-origin or inaccessible frame — skip (cannot inject into it)
    }
  }

  if (framesInjected > 1) {
    console.log(`[som] Injected marks into ${framesInjected} frames (main + iframes).`);
  }
  return elementMap;
}

/** Per-frame: count visible interactive elements (same logic as inject). */
async function countElementsInFrame(frame: Frame): Promise<number> {
  return frame.evaluate((sel: string) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
    let count = 0;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0)
        continue;
      count++;
    }
    return count;
  }, SOM_SELECTORS);
}

/** Per-frame: return current center of the Nth visible element (1-based). */
async function getCenterOfNthInFrame(
  frame: Frame,
  localIndex: number,
): Promise<{ x: number; y: number } | null> {
  return frame.evaluate(
    (arg: { sel: string; idx: number }): { x: number; y: number } | null => {
      const { sel, idx } = arg;
      const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
      let count = 0;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0)
          continue;
        count++;
        if (count === idx) {
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        }
      }
      return null;
    },
    { sel: SOM_SELECTORS, idx: localIndex },
  );
}

/**
 * Resolve badge ID to the element's current center in main-viewport coordinates,
 * searching the main page and all same-origin iframes. Use at action time to
 * avoid layout shift / stale coordinates.
 */
async function getCenterByBadgeId(
  page: Page,
  badgeId: number,
): Promise<{ x: number; y: number } | null> {
  if (badgeId < 1) return null;
  const frames = collectFrames(page);
  let cumulative = 0;
  for (const frame of frames) {
    let count: number;
    try {
      count = await countElementsInFrame(frame);
    } catch {
      continue;
    }
    const frameStart = cumulative + 1;
    const frameEnd = cumulative + count;
    if (badgeId >= frameStart && badgeId <= frameEnd) {
      const localIndex = badgeId - frameStart + 1;
      let offsetX = 0;
      let offsetY = 0;
      if (frame !== page.mainFrame()) {
        try {
          const frameEl = await frame.frameElement();
          if (frameEl) {
            const box = await frameEl.boundingBox();
            if (box) {
              offsetX = box.x;
              offsetY = box.y;
            }
          }
        } catch {
          return null;
        }
      }
      const center = await getCenterOfNthInFrame(frame, localIndex);
      if (!center) return null;
      return { x: offsetX + center.x, y: offsetY + center.y };
    }
    cumulative = frameEnd;
  }
  return null;
}

/** Run cleanup in a single frame (removes badges and data-prism-id). */
async function cleanupMarksInFrame(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    document.querySelectorAll("[data-prism-badge]").forEach((el) => el.remove());
    document.querySelectorAll<HTMLElement>("[data-prism-id]").forEach((el) => {
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
      el.style.removeProperty("position");
      el.style.removeProperty("z-index");
      el.removeAttribute("data-prism-id");
    });
  });
}

/**
 * Remove all injected SoM overlays from the main page and every accessible
 * frame so the next clean screenshot has no visual artifacts.
 */
async function cleanupMarks(page: Page): Promise<void> {
  const frames = collectFrames(page);
  for (const frame of frames) {
    try {
      await cleanupMarksInFrame(frame);
    } catch {
      // Cross-origin or inaccessible frame — skip
    }
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------
async function handleCapture(
  session: Session,
  socket: WebSocket,
): Promise<void> {
  const buffer = await session.page.screenshot({
    type: "jpeg",
    quality: 50,
    scale: "css",
    fullPage: false,
    animations: "disabled",
    timeout: 10_000,
  });
  send(socket, {
    type: "capture_result",
    imageBase64: buffer.toString("base64"),
    url: session.page.url(),
    timestamp: Date.now(),
  });
}

/**
 * After a click or type+Enter that might trigger navigation: wait for that
 * navigation to finish, or a short timeout if no navigation. Prevents
 * "Execution context was destroyed" when the next cycle runs evaluate/screenshot.
 */
async function waitForNavigationIfAny(page: Page): Promise<void> {
  await Promise.race([
    page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }),
    page.waitForTimeout(2_500),
  ]).catch(() => {});
}

/**
 * True if this verdict is the same click as the last executed action in history
 * (so we would be repeating a failed action and must intercept).
 */
function isDuplicateAction(verdict: GeminiVerdict, history: string[]): boolean {
  if (verdict.action_type !== "click" || verdict.target_id < 1) return false;
  const last = history[history.length - 1];
  if (typeof last !== "string") return false;
  return last.includes(`Clicked badge ${verdict.target_id}`);
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

  await session.page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});

  // ── Step 1: inject visual anchors ──────────────────────────────────────
  let elementMap = await injectMarks(session.page);
  console.log(`[som] ${elementMap.length} interactive elements marked.`);

  // ── Step 2: screenshot WITH marks visible ──────────────────────────────
  let buffer = await session.page.screenshot({
    type: "jpeg",
    quality: 50,
    scale: "css",
    fullPage: false,
    animations: "disabled",
    timeout: 10_000,
  });
  let imageBase64 = buffer.toString("base64");
  console.log(`[som] Screenshot base64 size: ${(imageBase64.length / 1024).toFixed(1)} KB`);

  // ── Step 3: ask Gemini; loop if it returns SCROLL ──────────────────────
  let verdict: GeminiVerdict;
  try {
    verdict = await analyzeMarkedScreenshot({
      imageBase64,
      objective: msg.objective,
      history,
    });

    // SCROLL loop: execute scroll, re-inject, re-screenshot, re-ask Gemini until non-scroll
    while (verdict.action_type === "scroll") {
      const dir = verdict.scroll_direction ?? "down";
      console.log(`[som] Gemini requested SCROLL ${dir}; executing then re-analyzing.`);
      await cleanupMarks(session.page);

      const beforeScroll = await session.page.evaluate(() => window.scrollY);
      await session.page.evaluate(
        (d: string) =>
          window.scrollBy(
            0,
            d === "down" ? window.innerHeight : -window.innerHeight,
          ),
        dir,
      );
      await session.page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => {});
      const afterScroll = await session.page.evaluate(() => window.scrollY);

      if (beforeScroll === afterScroll) {
        history.push(
          `Scroll failed. Reached the ${dir === "down" ? "bottom" : "top"} of the page.`,
        );
      } else {
        history.push(`Scrolled page ${dir}`);
      }

      await session.page.waitForTimeout(1_000);

      elementMap = await injectMarks(session.page);
      buffer = await session.page.screenshot({
        type: "jpeg",
        quality: 50,
        scale: "css",
        fullPage: false,
        animations: "disabled",
        timeout: 10_000,
      });
      imageBase64 = buffer.toString("base64");
      console.log(`[som] Screenshot base64 size: ${(imageBase64.length / 1024).toFixed(1)} KB`);
      verdict = await analyzeMarkedScreenshot({
        imageBase64,
        objective: msg.objective,
        history,
      });
    }

    // Duplicate-action interceptor: if Gemini returns the same click as the last executed action, do not send it; push warning and re-analyze
    const DUPLICATE_LOOP_MAX = 3;
    let duplicateCount = 0;
    while (duplicateCount < DUPLICATE_LOOP_MAX && isDuplicateAction(verdict, history)) {
      console.log(
        `[som] Duplicate action detected (click badge ${verdict.target_id}); injecting system warning and re-analyzing.`,
      );
      history.push(
        "[SYSTEM WARNING: You just attempted to execute the exact same action twice in a row. The UI did not change. You are in an infinite loop. You MUST select a different target or SCROLL.]",
      );
      duplicateCount++;
      await cleanupMarks(session.page);
      elementMap = await injectMarks(session.page);
      buffer = await session.page.screenshot({
        type: "jpeg",
        quality: 50,
        scale: "css",
        fullPage: false,
        animations: "disabled",
        timeout: 10_000,
      });
      imageBase64 = buffer.toString("base64");
      console.log(`[som] Screenshot base64 size: ${(imageBase64.length / 1024).toFixed(1)} KB`);
      verdict = await analyzeMarkedScreenshot({
        imageBase64,
        objective: msg.objective,
        history,
      });
    }

    const MALFORMED_JSON_MARKER = "System Error: You returned malformed JSON.";
    const MALFORMED_JSON_RETRY_MAX = 2;
    let malformedRetries = 0;
    while (
      malformedRetries < MALFORMED_JSON_RETRY_MAX &&
      verdict.is_error_state &&
      verdict.reasoning.includes(MALFORMED_JSON_MARKER)
    ) {
      console.log(`[som] Malformed JSON from Gemini; pushing to history and retrying (${malformedRetries + 1}/${MALFORMED_JSON_RETRY_MAX}).`);
      history.push(verdict.reasoning);
      malformedRetries++;
      await cleanupMarks(session.page);
      elementMap = await injectMarks(session.page);
      buffer = await session.page.screenshot({
        type: "jpeg",
        quality: 50,
        scale: "css",
        fullPage: false,
        animations: "disabled",
        timeout: 10_000,
      });
      imageBase64 = buffer.toString("base64");
      console.log(`[som] Screenshot base64 size: ${(imageBase64.length / 1024).toFixed(1)} KB`);
      verdict = await analyzeMarkedScreenshot({
        imageBase64,
        objective: msg.objective,
        history,
      });
    }
  } finally {
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
    ...(verdict.action_type === "scroll" && verdict.scroll_direction
      ? { scroll_direction: verdict.scroll_direction }
      : {}),
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
      const clickCoords =
        msg.target_id != null && msg.target_id >= 1
          ? await getCenterByBadgeId(session.page, msg.target_id)
          : null;
      const cx = clickCoords?.x ?? msg.x;
      const cy = clickCoords?.y ?? msg.y;
      if (clickCoords == null && msg.target_id != null && msg.target_id >= 1) {
        console.warn(
          `[som] Could not re-resolve badge ${msg.target_id} at click time; using stored coords (${msg.x}, ${msg.y}).`,
        );
      }
      // Race: in-page navigation vs new tab. Whichever happens first wins. Prefer in-page
      // so flows that navigate the main page are unchanged; only switch when a new tab
      // opens and the current page did not navigate (e.g. W3Schools "Try it Yourself").
      const context = session.page.context();
      const navPromise = session.page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 })
        .then(() => ({ kind: "nav" as const }));
      const popupPromise = context
        .waitForEvent("page", { timeout: 5_000 })
        .then((p) => ({ kind: "popup" as const, page: p }));
      await session.page.mouse.click(cx, cy);
      const winner = await Promise.race([navPromise, popupPromise]).catch(() => null);
      if (winner?.kind === "popup") {
        console.log(`[ws] Click opened new tab; switching session to it.`);
        await winner.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        const oldPage = session.page;
        session.page = winner.page;
        await oldPage.close().catch(() => {});
      } else if (winner?.kind === "nav") {
        // In-page navigation won; session already on the same page (now loaded)
      } else {
        await waitForNavigationIfAny(session.page);
      }
      break;
    }
    case "type": {
      const typeCoords =
        msg.target_id != null && msg.target_id >= 1
          ? await getCenterByBadgeId(session.page, msg.target_id)
          : null;
      const tx = typeCoords?.x ?? msg.x;
      const ty = typeCoords?.y ?? msg.y;
      if (typeCoords == null && msg.target_id != null && msg.target_id >= 1) {
        console.warn(
          `[som] Could not re-resolve badge ${msg.target_id} at type time; using stored coords (${msg.x}, ${msg.y}).`,
        );
      }
      await session.page.mouse.click(tx, ty);
      await session.page.waitForTimeout(80);
      await session.page.keyboard.type(msg.text);
      await session.page.keyboard.press("Enter");
      await waitForNavigationIfAny(session.page);
      break;
    }
    case "navigate": {
      try {
        await session.page.goto(msg.url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
      } catch (navErr) {
        const errMsg = navErr instanceof Error ? navErr.message : String(navErr);
        if (!errMsg.includes("Timeout") && !errMsg.includes("timeout")) throw navErr;
      }
      break;
    }
    case "scroll": {
      if (msg.direction === "up" || msg.direction === "down") {
        await session.page.evaluate(
          (dir: string) =>
            window.scrollBy(
              0,
              dir === "down" ? window.innerHeight : -window.innerHeight,
            ),
          msg.direction,
        );
      } else {
        await session.page.mouse.wheel(msg.deltaX ?? 0, msg.deltaY ?? 0);
      }
      break;
    }
  }

  // Give the page (and any iframes, e.g. result pane after "Run") time to update before next analyze.
  const postActionDelay = msg.action === "click" ? 2_500 : 1_000;
  await session.page.waitForTimeout(postActionDelay);

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

  // ── Token handshake: reject before provisioning any Playwright session ──
  const url = new URL(req.url ?? "/ws", "http://localhost");
  const token = url.searchParams.get("token");
  const secret = process.env["WS_SECRET_TOKEN"];
  if (!secret || token !== secret) {
    console.warn(`[ws] Unauthorized connection from ${clientIp} (missing or invalid token).`);
    socket.close(1008, "Unauthorized");
    return;
  }
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
        // Use domcontentloaded so sticky headers/ads don't block; heavy sites often never "load".
        const targetUrl = msg.url.trim();
        console.log(`[ws] Received init. Navigating to ${targetUrl}...`);
        try {
          await session.page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
        } catch (navErr) {
          const errMsg = navErr instanceof Error ? navErr.message : String(navErr);
          if (errMsg.includes("Timeout") || errMsg.includes("timeout")) {
            console.warn(`[ws] Navigation timeout; proceeding with current document.`);
          } else {
            throw navErr;
          }
        }
        await session.page.waitForTimeout(2_000);
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
          const badge =
            msg.target_id != null
              ? `Clicked badge ${msg.target_id} at (${msg.x}, ${msg.y})`
              : `Clicked at coordinates (${msg.x}, ${msg.y})`;
          sessionHistory.push(badge);
        } else if (msg.action === "type") {
          sessionHistory.push(
            `Typed "${msg.text}" into element at (${msg.x}, ${msg.y}) [target focused first]`,
          );
        } else if (msg.action === "navigate") {
          sessionHistory.push(`Navigated to ${msg.url}`);
        } else if (msg.action === "scroll") {
          const desc =
            msg.direction != null
              ? `Scrolled page ${msg.direction}`
              : `Scrolled page (deltaX: ${msg.deltaX ?? 0}, deltaY: ${msg.deltaY ?? 0})`;
          sessionHistory.push(desc);
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
