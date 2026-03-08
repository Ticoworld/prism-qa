#!/usr/bin/env bash
# ── Prism QA — Cloud Run Deployment ─────────────────────────────────────────
# Run from the backend/ directory.
# Requires: gcloud CLI authenticated + billing-enabled project set.
#
# Loads .env from this directory if present (GOOGLE_GENAI_API_KEY, WS_SECRET_TOKEN).
# Usage:   bash deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env so GOOGLE_GENAI_API_KEY and WS_SECRET_TOKEN are available for Cloud Run
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

: "${WS_SECRET_TOKEN:=prism_secure_hackathon_token_2026}"

if [ -z "${GOOGLE_GENAI_API_KEY:-}" ]; then
  echo "  ERROR: GOOGLE_GENAI_API_KEY is not set. Add it to backend/.env or export it before running deploy.sh"
  exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
echo ""
echo "  Deploying Prism QA Backend"
echo "  Project : ${PROJECT_ID}"
echo "  Region  : us-central1"
echo ""

gcloud run deploy prism-qa-backend \
  --source . \
  --region us-central1 \
  --min-instances 1 \
  --max-instances 1 \
  --session-affinity \
  --memory 2Gi \
  --allow-unauthenticated \
  --set-env-vars "WS_SECRET_TOKEN=${WS_SECRET_TOKEN},GOOGLE_GENAI_API_KEY=${GOOGLE_GENAI_API_KEY}"

echo ""
echo "  Deployment complete."
echo "  Set your frontend WS_URL to the Cloud Run URL printed above."
echo ""
