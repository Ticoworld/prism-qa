"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Circle,
  Crosshair,
  Eye,
  Loader,
  Play,
  RefreshCw,
  Square,
  Terminal,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import {
  useAgentSocket,
  type ServerMessage,
  type AnalyzeResultMessage,
} from "./hooks/useAgentSocket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CrosshairPos { x: number; y: number }
interface LogEntry    { id: number; ts: number; msg: ServerMessage }

let _id = 0;
const nextId = () => ++_id;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Connection badge
// ---------------------------------------------------------------------------
function Badge({ state }: { state: string }) {
  if (state === "connected")
    return (
      <div className="badge badge--live">
        <Wifi size={9} /><div className="badge-dot" />LIVE
      </div>
    );
  if (state === "connecting")
    return (
      <div className="badge badge--conn">
        <Loader size={9} className="animate-spin" />CONNECTING
      </div>
    );
  return (
    <div className="badge badge--off">
      <WifiOff size={9} /><div className="badge-dot" />OFFLINE
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log row
// ---------------------------------------------------------------------------
function LogRow({ entry }: { entry: LogEntry }) {
  const { msg, ts } = entry;
  let type = "";
  let rowCls = "";
  let body: React.ReactNode = null;

  if (msg.type === "session_ready") {
    type = "SESS"; rowCls = "log-row--ack";
    body = <><b>Session open</b> <span className="coord">{msg.url}</span></>;
  } else if (msg.type === "analyze_result") {
    const status = msg.action.task_status;
    type = "ANLZ";
    rowCls = msg.action.is_error_state || status === 'failed'
      ? "log-row--error"
      : status === 'completed' ? "log-row--ack" : "log-row--event";
    body = (
      <>
        <b>{msg.action.action_type.toUpperCase()}</b>{" "}
        {(msg.action.x_coordinate !== 0 || msg.action.y_coordinate !== 0) && (
          <span className="coord">@({msg.action.x_coordinate},{msg.action.y_coordinate}) </span>
        )}
        {msg.action.input_text && <span>&quot;{msg.action.input_text}&quot; </span>}
        {/* Status badge */}
        {status === 'completed' && (
          <span style={{ color: 'var(--G)', fontWeight: 700, marginRight: 4 }}>[DONE]</span>
        )}
        {status === 'failed' && (
          <span style={{ color: 'var(--R)', fontWeight: 700, marginRight: 4 }}>[FAIL]</span>
        )}
        <span className="opacity-60">{msg.action.reasoning}</span>
        {msg.action.is_error_state && <span className="err"> [ERR_STATE]</span>}
      </>
    );
  } else if (msg.type === "action_ack") {
    type = "EXEC"; rowCls = "log-row--ack";
    body = <><b>{msg.action.toUpperCase()}</b> dispatched</>;
  } else if (msg.type === "error") {
    type = "ERR "; rowCls = "log-row--error";
    body = <><span className="err">[{msg.code}]</span> {msg.message}</>;
  }

  return (
    <div className={`log-row ${rowCls}`}>
      <div className="log-col-time">{fmtTime(ts)}</div>
      <div className="log-col-type">{type}</div>
      <div className="log-col-body">{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function PrismQA() {
  const {
    connectionState, latestFrame, latestAnalysis,
    messageLog, sessionUrl, wsEndpoint, isNavigating, sendCapture, sendAnalyze, sendAction, sendInit,
    retryConnection,
  } = useAgentSocket();

  const [objective, setObjective]   = useState("");
  const [targetUrl, setTargetUrl]   = useState("http://localhost:3002");
  const [isRunning, setIsRunning]   = useState(false);
  const [crosshair, setCrosshair]   = useState<CrosshairPos | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [hoverCoord, setHoverCoord] = useState<{ x: number; y: number } | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [execCount, setExecCount]   = useState(0);

  const viewportRef    = useRef<HTMLDivElement>(null);
  const logRef         = useRef<HTMLDivElement>(null);
  const captureTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevAnalysis   = useRef<AnalyzeResultMessage | null>(null);
  const stableObjective = useRef<string>("");  // avoids stale closure in async loop
  const [vpSize, setVpSize] = useState({ w: 1280, h: 800 });

  // ── Frame polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (connectionState === "connected") {
      captureTimer.current = setInterval(() => {
        if (!isRunning) {
          sendCapture();
          setFrameCount((n) => n + 1);
        }
      }, 800);
    }
    return () => { if (captureTimer.current) clearInterval(captureTimer.current); };
  }, [connectionState, isRunning, sendCapture]);

  // ── Log sync: append only new messages so we never duplicate entries or keys ─
  useEffect(() => {
    if (!messageLog.length) return;
    setLogEntries((p) => {
      const need = messageLog.length - p.length;
      if (need <= 0) return p;
      const toAdd = messageLog.slice(p.length).map((msg) => ({
        id: nextId(),
        ts: Date.now(),
        msg,
      }));
      return [...p, ...toAdd];
    });
  }, [messageLog]);

  // ── Auto-scroll log ───────────────────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logEntries]);

  // ── ResizeObserver on viewport ────────────────────────────────────────────
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setVpSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Keep stable ref to objective to avoid stale closures in the async loop ─
  useEffect(() => { stableObjective.current = objective; }, [objective]);

  // ── Execute ───────────────────────────────────────────────────────────────
  const execute = useCallback(() => {
    if (!objective.trim() || isRunning || connectionState !== "connected") return;
    stableObjective.current = objective.trim();
    setIsRunning(true);
    setCrosshair(null);
    sendAnalyze(objective.trim());
  }, [objective, isRunning, connectionState, sendAnalyze]);

  // ── Handle analyze result → autonomous chaining loop ─────────────────────
  useEffect(() => {
    if (!latestAnalysis || latestAnalysis === prevAnalysis.current) return;
    prevAnalysis.current = latestAnalysis;
    const a = latestAnalysis.action;
    setExecCount((n) => n + 1);

    // Update crosshair for any action with resolved coordinates
    if (a.x_coordinate !== 0 || a.y_coordinate !== 0) {
      setCrosshair({ x: a.x_coordinate, y: a.y_coordinate });
    }

    const status = a.task_status;

    if (status === 'completed') {
      // ── HALT: objective achieved ──────────────────────────────────────────
      setIsRunning(false);
      return;
    }

    if (status === 'failed') {
      // ── HALT: blocking error ──────────────────────────────────────────────
      setIsRunning(false);
      return;
    }

    // ── in_progress: execute the action, then re-analyze ──────────────────
    const EXEC_DELAY   = 1000;  // ms before dispatching the action
    const SETTLE_DELAY = 2000;  // ms after action for UI animations to settle

    setTimeout(() => {
      const execs = ['click', 'type', 'navigate', 'scroll', 'press_escape'];
      if (execs.includes(a.action_type)) sendAction(a);

      // After the action, wait for the page to settle, then loop
      setTimeout(() => {
        sendCapture();
        // Give the frame time to arrive, then re-analyze with the same objective
        setTimeout(() => {
          const obj = stableObjective.current;
          if (obj) sendAnalyze(obj);
        }, 800);
      }, SETTLE_DELAY);
    }, EXEC_DELAY);
  }, [latestAnalysis, sendAction, sendCapture, sendAnalyze]);

  // ── Coord display crosshair ───────────────────────────────────────────────
  const displayed = crosshair
    ? { x: (crosshair.x / 1280) * vpSize.w, y: (crosshair.y / 800) * vpSize.h }
    : null;

  const handleVpMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
    const py = Math.round(((e.clientY - rect.top) / rect.height) * 800);
    setHoverCoord({ x: px, y: py });
  };

  const lastA = latestAnalysis?.action;
  const canRun = objective.trim().length > 0 && !isRunning && connectionState === "connected";

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-1)" }}>

      {/* ═══ TOP HEADER BAR ═════════════════════════════════════════════════ */}
      <div style={{
        height: 36, display: "flex", alignItems: "stretch",
        borderBottom: "1px solid var(--wire)", background: "var(--bg-0)",
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{
          padding: "0 14px", display: "flex", alignItems: "center", gap: 8,
          borderRight: "1px solid var(--wire)",
        }}>
          <Eye size={12} color="var(--A)" />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.22em", color: "var(--fg-0)" }}>
            PRISM<span style={{ color: "var(--A)" }}>.</span>QA
          </span>
        </div>

        {/* Breadcrumb */}
        <div style={{
          padding: "0 12px", display: "flex", alignItems: "center", gap: 6,
          borderRight: "1px solid var(--wire)", color: "var(--fg-2)", fontSize: 10,
          letterSpacing: "0.1em",
        }}>
          <ChevronRight size={9} color="var(--fg-2)" />
          VISUAL TESTING AGENT
          <ChevronRight size={9} color="var(--fg-2)" />
          <span style={{ color: "var(--fg-1)" }}>SESSION_01</span>
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", alignItems: "stretch", marginLeft: "auto" }}>
          <div className="stat-cell" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <span className="stat-label">FRAMES</span>
            <span className="stat-value" style={{ fontSize: 11 }}>{frameCount}</span>
          </div>
          <div className="stat-cell" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <span className="stat-label">EXECS</span>
            <span className={`stat-value ${execCount > 0 ? "stat-value--accent" : ""}`} style={{ fontSize: 11 }}>
              {execCount}
            </span>
          </div>
          {lastA && (
            <div className="stat-cell" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <span className="stat-label">LAST</span>
              <span className="stat-value stat-value--accent" style={{ fontSize: 11 }}>
                {lastA.action_type.toUpperCase()}
              </span>
            </div>
          )}
          {sessionUrl && (
            <div className="stat-cell" style={{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 240 }}>
              <span className="stat-label">URL</span>
              <span style={{ fontSize: 10, color: "var(--fg-1)", fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {sessionUrl}
              </span>
            </div>
          )}
          <Badge state={connectionState} />
        </div>
      </div>

      {/* ═══ BODY ══════════════════════════════════════════════════════════ */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

        {/* ─── LEFT: VIEWPORT ─────────────────────────────────────────────── */}
        <div style={{
          width: "62%", display: "flex", flexDirection: "column",
          borderRight: "1px solid var(--wire)", background: "var(--bg-0)",
        }}>
          {/* Viewport toolbar */}
          <div className="toolbar">
            <div className="panel-label" style={{ borderRight: "1px solid var(--wire)", paddingRight: 12 }}>
              <Crosshair size={9} color="var(--fg-2)" />
              LIVE VIEWPORT
            </div>
            <div className="toolbar-readout" style={{ minWidth: 120 }}>
              <Square size={8} color="var(--fg-2)" />
              1280 × 800
            </div>
            {hoverCoord && (
              <div className="toolbar-readout">
                <Crosshair size={8} color="var(--A)" />
                <span style={{ color: "var(--A)" }}>
                  x:{hoverCoord.x} y:{hoverCoord.y}
                </span>
              </div>
            )}
            {displayed && !isRunning && (
              <div className="toolbar-readout">
                <span style={{ color: "var(--R)", fontSize: 9 }}>
                  TARGET ({crosshair?.x},{crosshair?.y})
                </span>
              </div>
            )}
            <div className="toolbar-spacer" />
            {isRunning && (
              <div className="toolbar-readout">
                <Loader size={8} className="animate-spin" color="var(--A)" />
                <span style={{ color: "var(--A)" }}>ANALYZING</span>
              </div>
            )}
            <button
              className="toolbar-btn"
              onClick={() => { sendCapture(); setFrameCount((n) => n + 1); }}
              disabled={connectionState !== "connected"}
            >
              <RefreshCw size={9} />CAPTURE
            </button>
          </div>

          {/* Viewport with rulers */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Top ruler */}
            <div style={{ display: "flex", flexShrink: 0 }}>
              <div className="ruler-corner" />
              <div className="ruler-x" style={{ flex: 1 }} />
            </div>

            {/* Ruler Y + Canvas */}
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
              <div className="ruler-y" style={{ flexShrink: 0 }} />

              {/* Canvas */}
              <div
                ref={viewportRef}
                style={{ flex: 1, position: "relative", overflow: "hidden", background: "var(--bg-0)" }}
                onMouseMove={handleVpMouseMove}
                onMouseLeave={() => setHoverCoord(null)}
              >
                {latestFrame ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:image/png;base64,${latestFrame}`}
                    alt="Live browser session"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : (
                  <div style={{
                    position: "absolute", inset: 0, display: "flex",
                    flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
                  }}>
                    <div className="shimmer" style={{ position: "absolute", inset: 0, opacity: 0.25 }} />
                    {connectionState === "connecting" && (
                      <Loader size={24} className="animate-spin" color="var(--A)" style={{ position: "relative" }} />
                    )}
                    {connectionState === "error" && (
                      <>
                        <span style={{ position: "relative", fontSize: 10, color: "var(--R)", textAlign: "center", maxWidth: 280 }}>
                          Connection timed out. The backend may be starting up or unreachable.
                        </span>
                        <button
                          type="button"
                          onClick={retryConnection}
                          style={{
                            position: "relative",
                            padding: "6px 14px",
                            fontFamily: "var(--mono)",
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: "0.1em",
                            background: "var(--A)",
                            color: "var(--bg-0)",
                            border: "1px solid var(--A)",
                            cursor: "pointer",
                            textTransform: "uppercase",
                          }}
                        >
                          Try again
                        </button>
                      </>
                    )}
                    {connectionState !== "error" && (
                      <span className={connectionState === "connecting" ? "cold-start-pulse" : ""} style={{ position: "relative", fontSize: 9, letterSpacing: "0.12em", color: "var(--fg-2)", textTransform: "uppercase", textAlign: "center" }}>
                        {connectionState === "connecting"
                          ? "PROVISIONING CLOUD INFRASTRUCTURE... PLEASE WAIT"
                          : connectionState === "connected"
                            ? "AWAITING FRAME..."
                            : "NO AGENT CONNECTION"}
                      </span>
                    )}
                    {connectionState === "connected" && !latestFrame && (
                      <Eye size={20} color="var(--fg-3)" style={{ position: "relative" }} />
                    )}
                  </div>
                )}

                {/* CRT scanlines */}
                <div className="scanlines" />

                {/* Crosshair */}
                {displayed && (
                  <>
                    <div className="ch-h" style={{ top: displayed.y }} />
                    <div className="ch-v" style={{ left: displayed.x }} />
                    <div className="ch-dot" style={{ top: displayed.y, left: displayed.x }} />
                    <div className="ch-ring" style={{ top: displayed.y, left: displayed.x }} />
                    {/* coordinate label */}
                    <div style={{
                      position: "absolute",
                      top: Math.max(displayed.y - 24, 4),
                      left: Math.min(displayed.x + 6, vpSize.w - 120),
                      background: "var(--bg-0)",
                      border: "1px solid var(--R)",
                      padding: "1px 5px",
                      fontFamily: "var(--mono)",
                      fontSize: 9,
                      color: "var(--R)",
                      pointerEvents: "none",
                      zIndex: 30,
                      letterSpacing: "0.05em",
                    }}>
                      {crosshair?.x},{crosshair?.y}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ─── RIGHT: COMMAND CENTER ───────────────────────────────────────── */}
        <div style={{ width: "38%", display: "flex", flexDirection: "column", background: "var(--bg-1)" }}>

          {/* Command toolbar */}
          <div className="toolbar">
            <div className="panel-label" style={{ borderRight: "1px solid var(--wire)", paddingRight: 12, color: isRunning ? "var(--A)" : undefined }}>
              <Zap size={9} color={isRunning ? "var(--A)" : "var(--fg-2)"} />
              COMMAND CENTER
            </div>
            <div className="toolbar-spacer" />
            <div className="toolbar-readout">
              <Activity size={8} color="var(--fg-2)" />
              GEMINI-2.5-FLASH
            </div>
          </div>

          {/* ── TARGET URL ─────────────────────────────────────────────────── */}
          <div style={{
            padding: "8px 10px",
            borderBottom: "1px solid var(--wire)",
            background: "var(--bg-2)",
            flexShrink: 0,
            display: "flex", flexDirection: "column", gap: 5,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--fg-2)", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                TARGET URL
              </span>
              <div style={{ flex: 1, height: 1, background: "var(--wire)" }} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id="target-url-input"
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendInit(targetUrl.trim()); }}
                placeholder="https://your-saas.com"
                disabled={connectionState !== "connected"}
                style={{
                  flex: 1,
                  background: "var(--bg-0)",
                  border: "1px solid var(--wire)",
                  color: "var(--fg-0)",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  padding: "5px 8px",
                  outline: "none",
                }}
              />
              <button
                id="connect-btn"
                onClick={() => sendInit(targetUrl.trim())}
                disabled={connectionState !== "connected" || !targetUrl.trim() || isNavigating}
                style={{
                  padding: "0 12px",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  background: isNavigating ? "var(--wire-2)" : sessionUrl ? "var(--bg-3)" : "var(--A)",
                  color: sessionUrl && !isNavigating ? "var(--fg-2)" : "var(--bg-0)",
                  border: "1px solid " + (isNavigating ? "var(--wire)" : sessionUrl ? "var(--wire)" : "var(--A)"),
                  cursor: connectionState === "connected" && !isNavigating ? "pointer" : "not-allowed",
                  textTransform: "uppercase" as const,
                  whiteSpace: "nowrap" as const,
                }}
              >
                {isNavigating ? <><Loader size={10} className="animate-spin" style={{ marginRight: 4 }} />NAVIGATING...</> : sessionUrl ? "RECONNECT" : "CONNECT"}
              </button>
            </div>
          </div>

          {/* Objective block */}
          <div style={{
            padding: "10px 10px 0",
            borderBottom: "1px solid var(--wire)",
            background: "var(--bg-2)",
            flexShrink: 0,
            paddingBottom: 10,
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            {/* Field label */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--fg-2)", textTransform: "uppercase" }}>
                OBJECTIVE
              </span>
              <div style={{ flex: 1, height: 1, background: "var(--wire)" }} />
              <span style={{ fontSize: 9, color: "var(--fg-2)" }}>ENTER ↵</span>
            </div>
            <input
              id="objective-input"
              className="obj-input"
              type="text"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") execute(); }}
              placeholder={'e.g. Click Try it Yourself, add <p id="prism-test">run confirmed</p> in the code body, click Run, confirm "run confirmed" in the result pane'}
              disabled={connectionState !== "connected" || isRunning}
            />
            <button
              id="execute-btn"
              className={`exec-btn ${isRunning ? "exec-btn--running" : ""}`}
              onClick={execute}
              disabled={!canRun}
            >
              {isRunning
                ? <><Loader size={11} className="animate-spin" />ANALYZING VIEWPORT...</>
                : <><Play size={11} />EXECUTE OBJECTIVE</>
              }
            </button>
            {isRunning && (
              <p style={{ margin: 0, fontSize: 10, color: "var(--fg-2)", fontStyle: "italic" }}>
                Scroll + Gemini may take 1–2 min on long pages.
              </p>
            )}
          </div>

          {/* Latest verdict */}
          {lastA && (
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--wire)", flexShrink: 0 }}>
              <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--fg-2)", textTransform: "uppercase", marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}>
                <ChevronRight size={8} />
                LAST VERDICT
              </div>
              <div className={`verdict ${lastA.is_error_state || lastA.task_status === 'failed' ? 'verdict--error' : lastA.task_status === 'completed' ? 'verdict--ok' : ''}`}>
                <span className="verdict-k">ACTION</span>
                <span className={`verdict-v ${lastA.is_error_state ? 'verdict-v--error' : 'verdict-v--accent'}`}>
                  {lastA.action_type.toUpperCase()}
                </span>

                <span className="verdict-k">STATUS</span>
                <span className={`verdict-v ${
                  lastA.task_status === 'completed' ? 'verdict-v--ok' :
                  lastA.task_status === 'failed' ? 'verdict-v--error' : 'verdict-v--accent'
                }`}>
                  {lastA.task_status?.toUpperCase() ?? 'IN_PROGRESS'}
                </span>

                <span className="verdict-k">COORDS</span>
                <span className="verdict-v">({lastA.x_coordinate}, {lastA.y_coordinate})</span>

                {lastA.input_text && <>
                  <span className="verdict-k">INPUT</span>
                  <span className="verdict-v" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    &quot;{lastA.input_text}&quot;
                  </span>
                </>}

                <span className="verdict-k">STATE</span>
                <span className={`verdict-v ${lastA.is_error_state ? 'verdict-v--error' : ''}`}>
                  {lastA.is_error_state
                    ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={9} />ERROR DETECTED</span>
                    : 'NOMINAL'
                  }
                </span>

                <span className="verdict-k" style={{ gridColumn: '1/-1', color: 'var(--fg-2)', borderTop: '1px solid var(--wire)', paddingTop: 4, marginTop: 2 }}>
                  REASON
                </span>
                <span className="verdict-v" style={{ gridColumn: '1/-1', color: 'var(--fg-1)', fontSize: 10.5, lineHeight: 1.5 }}>
                  {lastA.reasoning}
                </span>
              </div>
            </div>
          )}

          {/* Telemetry panel */}
          <div style={{
            display: "flex", gap: 16, padding: "8px 10px", borderBottom: "1px solid var(--wire)",
            background: "var(--bg-2)", flexShrink: 0,
            fontSize: 9, letterSpacing: "0.1em", color: "var(--fg-2)", textTransform: "uppercase",
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              Confidence Score:
              <span style={{ color: "var(--fg-1)", fontFamily: "var(--mono)", fontWeight: 700 }}>
                {latestAnalysis?.action?.confidence_score != null
                  ? `${latestAnalysis.action.confidence_score}%`
                  : "---"}
              </span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              System Latency:
              <span style={{ color: "var(--fg-1)", fontFamily: "var(--mono)", fontWeight: 700 }}>
                {latestAnalysis?.injection_latency_ms != null
                  ? `${latestAnalysis.injection_latency_ms}ms`
                  : "---"}
              </span>
            </span>
          </div>

          {/* Terminal log header */}
          <div style={{
            height: 28, display: "flex", alignItems: "center", gap: 6,
            padding: "0 10px", borderBottom: "1px solid var(--wire)",
            background: "var(--bg-2)", flexShrink: 0,
          }}>
            <Terminal size={9} color="var(--fg-2)" />
            <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--fg-2)", textTransform: "uppercase" }}>AGENT LOG</span>
            <div style={{ flex: 1 }} />
            <span style={{
              fontSize: 9, letterSpacing: "0.1em",
              padding: "0 5px", border: "1px solid var(--wire)",
              color: "var(--fg-2)", background: "var(--bg-0)",
            }}>
              {logEntries.length.toString().padStart(4, "0")}
            </span>
          </div>

          {/* Log body */}
          <div
            ref={logRef}
            style={{ flex: 1, overflowY: "auto", padding: "4px 10px 4px", minHeight: 0 }}
          >
            {logEntries.length === 0 ? (
              <div style={{
                height: "100%", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 8,
                color: "var(--fg-2)",
              }}>
                <Circle size={12} />
                <span style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                  AWAITING EVENTS
                </span>
              </div>
            ) : (
              logEntries.map((e, i) => <LogRow key={`log-${i}-${e.id}`} entry={e} />)
            )}
          </div>
        </div>
      </div>

      {/* ═══ STATUS BAR ════════════════════════════════════════════════════ */}
      <div style={{
        height: 22, display: "flex", alignItems: "center",
        borderTop: "1px solid var(--wire)", background: "var(--bg-0)",
        padding: "0 8px", gap: 16, flexShrink: 0,
        fontSize: 9, letterSpacing: "0.1em", color: "var(--fg-2)",
        fontFamily: "var(--mono)",
      }}>
        <span>PRISM QA v0.1.0</span>
        <span style={{ color: "var(--wire-3)" }}>|</span>
        <span>PLAYWRIGHT/CHROMIUM</span>
        <span style={{ color: "var(--wire-3)" }}>|</span>
        <span style={{ color: "var(--fg-2)" }}>WS {wsEndpoint}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: connectionState === "connected" ? "var(--G)" : "var(--R)" }}>
          {connectionState.toUpperCase()}
        </span>
        <span style={{ color: "var(--wire-3)" }}>|</span>
        <span>{new Date().toLocaleDateString("en-CA")} UTC+1</span>
      </div>
    </div>
  );
}
