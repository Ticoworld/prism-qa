import { GoogleGenAI, Type } from "@google/genai";

// ---------------------------------------------------------------------------
// Client — lazy singleton (initialized on first use so a missing key does
// not crash the process at boot time — Cloud Run can still pass health checks)
// ---------------------------------------------------------------------------
let _ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env["GOOGLE_GENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "[agent] GOOGLE_GENAI_API_KEY is not set. Inject it via Cloud Run env vars.",
    );
  }
  _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

const MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Structured output schema — Set-of-Mark edition
//
// The model NO LONGER guesses raw pixel coordinates.
// The screenshot will contain red numbered badges on every interactive
// element. The model must return the badge number of the target element.
// The backend resolves that number → exact center coordinates.
// ---------------------------------------------------------------------------
const SOM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scene_understanding: {
      type: Type.STRING,
      description:
        "Brief analysis of the current visual state. Identify if any dropdowns, modals, or error screens are present. Required before selecting an action.",
    },
    target_id: {
      type: Type.NUMBER,
      description:
        "The numeric ID shown inside the red badge on the target element. " +
        "Return -1 if the action does not require a specific element " +
        '(e.g. action_type is "wait", "verify", "none", "completed", "failed", or "press_escape").',
    },
    action_type: {
      type: Type.STRING,
      description:
        "The action to execute on the identified element. " +
        "One of: click | type | scroll | navigate | wait | verify | none | press_escape.",
    },
    scroll_direction: {
      type: Type.STRING,
      enum: ["up", "down"],
      description:
        'Only used when action_type is "scroll". Set to "down" to scroll down by one viewport height, or "up" to scroll up. Omit or leave empty for non-scroll actions.',
    },
    input_text: {
      type: Type.STRING,
      description:
        'For action_type "type": the exact string to type into the element. ' +
        'For action_type "navigate": the fully-qualified target URL. ' +
        "Empty string for all other action types.",
    },
    is_error_state: {
      type: Type.BOOLEAN,
      description:
        "True if the current screenshot shows an error UI state " +
        "(error banner, validation message, HTTP error page, broken layout).",
    },
    task_status: {
      type: Type.STRING,
      enum: ["in_progress", "completed", "failed"],
      description:
        "Overall status of the multi-step objective. " +
        '"in_progress": the goal is not yet achieved, more steps are needed. ' +
        '"completed": the screenshot confirms the objective is fully done. ' +
        '"failed": a blocking error prevents the objective from being achieved.',
    },
    reasoning: {
      type: Type.STRING,
      description:
        "One concise sentence identifying which badge number was selected and why. " +
        'If task_status is "completed" or "failed", describe what visual evidence confirms that status.',
    },
    confidence_score: {
      type: Type.NUMBER,
      description:
        "Your visual certainty for the chosen action. An integer between 0 and 100. " +
        "100 = target is perfectly visible and unambiguous; lower = less certain.",
    },
  },
  required: [
    "scene_understanding",
    "target_id",
    "action_type",
    "input_text",
    "is_error_state",
    "task_status",
    "reasoning",
    "confidence_score",
  ],
};

// ---------------------------------------------------------------------------
// System prompt — badge-ID resolver, not a coordinate guesser
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an automated QA testing agent using a Set-of-Mark (SoM) visual grounding system.

CONTEXT:
Every interactive element in the screenshot has been marked with a distinctive red numeric badge in its top-left corner and a red border. These badges are your navigation system. You must use them — do NOT attempt to guess raw pixel coordinates.

Before selecting an action, you must write a brief analysis of the current visual state in scene_understanding. Identify if any dropdowns, modals, or error screens are present.

If a modal, dropdown, or overlay is blocking the screen, use the PRESS_ESCAPE action to dismiss it before attempting to interact with the UI.

You are provided with a DOM Element Map (badge ID → visible text, e.g. placeholder or label). You MUST verify the exact text of a badge matches your target before clicking.

PROCESS:
1. Read the OBJECTIVE.
2. Evaluate whether the objective has already been achieved based on the current screenshot.
3. If not yet achieved, scan for the red-badged element that fulfills the next step.
4. Return the integer badge number as target_id.
5. Set action_type to the correct action for that element.
6. Set task_status based on the current state of the overall objective.
7. Write one concise sentence in reasoning, identifying which badge number was selected and why. If task_status is "completed" or "failed", describe what visual evidence confirms that status. Keep reasoning to one short sentence so the JSON is not truncated.
8. You must evaluate your visual certainty for the chosen action. Output an integer confidence_score between 0 and 100. 100 means the target is perfectly visible and unambiguous; lower values mean less certainty.

TARGET_ID RULES:
- Return the exact integer shown in the red badge.
- If the objective requires no element interaction (wait, verify, none, completed, failed), return target_id = -1.
- Never invent a target_id that does not appear as a badge in the screenshot.
- If the objective requires interacting with an element that is not currently visible in the provided screenshot, you MUST output the SCROLL action (with scroll_direction "down" or "up" as appropriate). Do NOT guess or hallucinate badge IDs for elements you cannot see.

TASK STATUS EVALUATION (CRITICAL):
- "in_progress": The objective is NOT fully met. More actions are required. Return the next action.
- "completed": The screenshot VISUALLY CONFIRMS the objective is fully achieved.
  Example: objective was to reach a success page, and you can see a success screen, checkmark, or welcome message.
  When returning "completed", set action_type to "none" and target_id to -1.
- "failed": A BLOCKING ERROR prevents the objective. Examples: error banner, validation error that cannot be dismissed,
  HTTP 500 page, or blank/broken layout. Document the exact visual error in reasoning.
  When returning "failed", set action_type to "none" and target_id to -1.

CRITICAL NAVIGATION RULE: You are strictly forbidden from returning a FAILED status or a NONE action simply because the target element is not visible in the current initial viewport. Web pages are long. If the objective requires interacting with an element you cannot currently see, you MUST return the SCROLL action to navigate the page. You may only return a FAILED status if you have scrolled the entire page and mathematically confirmed the element does not exist.

MEMORY AND LOOP PREVENTION: You are provided with an Action History. You are strictly forbidden from repeating the exact same action twice in a row. If your last action was CLICK badge N, and the new screenshot looks identical, the click failed. You MUST choose a different badge, output the SCROLL action to find new elements, or output a FAILED status. Repeating an action is a critical failure.

DATA ENTRY RULES:
- If the objective requires entering text into a field, set action_type to "type" — NOT "click".
- Set target_id to the badge number of the INPUT or TEXTAREA element.
- Set input_text to the EXACT string to type.
- The backend will click to focus before typing. You do not need a separate click step.

ACTION TYPES:
- click         → single left-click on the element with this target_id
- type          → focus + keyboard input; ALWAYS set input_text to exact string
- scroll        → scroll the page by one viewport; set scroll_direction to "up" or "down"; target_id = -1
- navigate      → full page navigation; set input_text to URL; target_id = -1
- press_escape  → dismiss modal/dropdown/overlay; target_id = -1. Use when an overlay blocks the UI.
- wait          → element not yet visible; target_id = -1
- none          → used when task_status is "completed" or "failed"

LINK TEXT MATCH (CRITICAL): When the objective asks to click a link by name (e.g. "Privacy policy", "facebook/react", "Terms of Use"), you MUST select the element whose visible text matches that name exactly or is the full phrase. Do NOT click a link that only contains a substring.
- Example: If the objective says "click on the official facebook/react repository", you MUST choose a badge whose visible text is exactly "facebook/react" or "Facebook/react" (org/repo format). Do NOT click a badge that shows a different repo (e.g. "duxianwei520/react", "reduxjs/redux", or any result that contains "react" but is not the exact org/repo name). If the correct link is not visible, SCROLL to find it or return task_status "failed" with reasoning that the exact link was not found.
- If the session history already shows "Clicked badge N" and the objective is still not achieved (e.g. wrong link was clicked), do NOT return the same target_id again. Choose a different badge that exactly matches the objective link text, or return task_status "failed" with reasoning.

RE-SEARCH LOOP (CRITICAL): If the Action History shows that you already performed a search (e.g. typed a query into a search bar) and then clicked a search result, and the current page is not the target (e.g. you landed on a different repo or topic page), you MUST NOT click the search bar again and type the same query. That causes an infinite loop. Instead: (1) SCROLL the current page to find a link whose visible text exactly matches the objective (e.g. facebook/react), or (2) return task_status "failed" with reasoning that the correct link was not found after the previous click. Do not re-trigger search.

CODE EDITOR + RUN (e.g. W3Schools Tryit): When the objective is to edit code and click Run, the result of Run appears in the main preview/result pane (the rendered output of the edited document). If the page has an iframe with its own src (e.g. demo_iframe.htm), that iframe content does NOT change when you edit the main code — and that is expected. Do NOT return "failed" with "changes won't appear inside the iframe". Instead, add the requested HTML in the editable code (e.g. inside <body>), click Run, then confirm the new content appears in the main result area (outside the iframe). Set "completed" when you see that content in the preview.

NATIVE DROPDOWN RULE (CRITICAL):
Native HTML <select> dropdowns render their options via the OS, not the DOM. You cannot click their options.
If you need to select a dropdown option:
1. Return the target_id of the <select> element itself (the badge on the dropdown box, NOT the options).
2. Set action_type to "type".
3. Set input_text to the EXACT visible text of the option you want (e.g., "11-50 people" or "11-50").
The backend will type that text and press Enter, which locks in the selection.
DO NOT use action_type "click" on a dropdown selection. It will fail.

STRICT RULE: Return only valid JSON. No prose, no markdown, no code fences.`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What Gemini returns — scene analysis, badge ID, task_status, and action details */
export interface GeminiVerdict {
  /** Brief analysis of the current visual state (dropdowns, modals, errors). */
  scene_understanding: string;
  target_id: number;
  action_type: string;
  /** When action_type is "scroll", must be "up" or "down". */
  scroll_direction?: "up" | "down";
  input_text: string;
  is_error_state: boolean;
  task_status: "in_progress" | "completed" | "failed";
  reasoning: string;
  /** 0–100 visual certainty for the chosen action. */
  confidence_score: number;
}

export interface AnalyzeOptions {
  /** Base64-encoded PNG of the SoM-marked screenshot */
  imageBase64: string;
  /** Natural language objective */
  objective: string;
  /** Ordered list of actions already taken this session */
  history?: string[];
  /** Badge ID → visible text (up to 30 chars) for DOM Element Map in prompt */
  domTextMap?: Record<number, string>;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
export async function analyzeMarkedScreenshot(
  opts: AnalyzeOptions,
): Promise<GeminiVerdict> {
  const { imageBase64, objective, history, domTextMap } = opts;

  // Build the history block injected at the top of the user turn.
  // Placed BEFORE the image so the model reads context first.
  const historyBlock =
    history && history.length > 0
      ? [
          "--- SESSION HISTORY (actions already successfully executed, DO NOT REPEAT) ---",
          ...history.map((h, i) => `${i + 1}. ${h}`),
          "--- END HISTORY ---",
          "",
          "CRITICAL: Review the history above. Do NOT type into a field you have already typed into.",
          "If a field already has a value (including masked password dots), skip it and action the NEXT step.",
        ].join("\n")
      : null;

  const safeFailure = (reason: string): GeminiVerdict => ({
    scene_understanding: "",
    target_id: -1,
    action_type: "none",
    input_text: "",
    is_error_state: true,
    task_status: "failed",
    reasoning: reason,
    confidence_score: 0,
  });

  const domMapBlock =
    domTextMap && Object.keys(domTextMap).length > 0
      ? `DOM Element Map (verify badge text before clicking):\n${Object.entries(domTextMap)
          .map(([id, text]) => `  ${id}: "${text.replace(/"/g, '\\"')}"`)
          .join("\n")}\n`
      : "";

  try {
    const response = await getClient().models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            ...(historyBlock ? [{ text: historyBlock }] : []),
            ...(domMapBlock ? [{ text: domMapBlock }] : []),
            { inlineData: { mimeType: "image/png", data: imageBase64 } },
            { text: `OBJECTIVE: ${objective}` },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: SOM_SCHEMA,
        temperature: 0,
        maxOutputTokens: 2048,
      },
    });

    const raw = response.text;
    if (!raw) {
      console.error("[agent] Gemini returned an empty response.");
      return safeFailure("Model returned empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Often truncation: response cut mid-key (e.g. "is_error). Try closing the object.
      const repaired = tryRepairTruncatedJson(raw);
      if (repaired !== null) {
        parsed = repaired;
      } else {
        console.error(`[agent] Malformed JSON from Gemini: ${raw.slice(0, 300)}`);
        return safeFailure(
          "System Error: You returned malformed JSON. You MUST output strictly valid JSON.",
        );
      }
    }

    try {
      return validateVerdict(parsed);
    } catch {
      console.error(`[agent] Invalid verdict shape from Gemini: ${raw.slice(0, 300)}`);
      return safeFailure(
        "System Error: You returned malformed JSON. You MUST output strictly valid JSON.",
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent] Gemini API error: ${msg}`);
    return safeFailure(`Gemini API error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Truncation repair — Gemini sometimes returns cut-off JSON
// ---------------------------------------------------------------------------
const REQUIRED_KEYS = [
  "scene_understanding",
  "target_id",
  "action_type",
  "input_text",
  "is_error_state",
  "task_status",
  "reasoning",
  "confidence_score",
] as const;

const DEFAULTS: Record<string, unknown> = {
  scene_understanding: "",
  target_id: -1,
  action_type: "none",
  input_text: "",
  is_error_state: false,
  task_status: "in_progress",
  reasoning: "",
  confidence_score: 50,
};

function tryRepairTruncatedJson(raw: string): unknown | null {
  const s = raw.trim();
  const attempts: string[] = [
    s + "}",
    s + "\"}",
    s + "_state\":false,\"task_status\":\"in_progress\",\"reasoning\":\"\"}",
  ];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) {
        for (const key of REQUIRED_KEYS) {
          if (!(key in parsed) || parsed[key] === undefined)
            parsed[key] = DEFAULTS[key];
        }
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------
function validateVerdict(raw: unknown): GeminiVerdict {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("[agent] Response is not a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  const required: (keyof GeminiVerdict)[] = [
    "scene_understanding",
    "target_id",
    "action_type",
    "input_text",
    "is_error_state",
    "task_status",
    "reasoning",
    "confidence_score",
  ];
  for (const f of required) {
    if (!(f in obj)) throw new Error(`[agent] Missing field: "${f}"`);
  }
  if (typeof obj["scene_understanding"] !== "string")
    throw new Error("[agent] scene_understanding must be a string");
  if (typeof obj["target_id"] !== "number")
    throw new Error("[agent] target_id must be a number");
  if (typeof obj["action_type"] !== "string")
    throw new Error("[agent] action_type must be a string");
  if (typeof obj["input_text"] !== "string")
    throw new Error("[agent] input_text must be a string");
  if (typeof obj["is_error_state"] !== "boolean")
    throw new Error("[agent] is_error_state must be a boolean");
  if (typeof obj["reasoning"] !== "string")
    throw new Error("[agent] reasoning must be a string");
  if (typeof obj["confidence_score"] !== "number")
    throw new Error("[agent] confidence_score must be a number");
  const score = Number(obj["confidence_score"]);
  if (score < 0 || score > 100)
    throw new Error("[agent] confidence_score must be between 0 and 100");
  const validStatuses = ["in_progress", "completed", "failed"];
  if (!validStatuses.includes(String(obj["task_status"]))) {
    throw new Error(
      `[agent] task_status must be one of: ${validStatuses.join(", ")}`,
    );
  }

  return obj as unknown as GeminiVerdict;
}
