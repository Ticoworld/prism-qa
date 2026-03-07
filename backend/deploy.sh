#!/usr/bin/env bash
# ── Prism QA — Cloud Run Deployment ─────────────────────────────────────────
# Run from the backend/ directory.
# Requires: gcloud CLI authenticated + billing-enabled project set.
#
# Set GOOGLE_GENAI_API_KEY in Cloud Run (Console → Edit → Variables) if not already set.
#
# Usage:   bash deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail

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
  --set-env-vars "WS_SECRET_TOKEN=prism_secure_hackathon_token_2026"

echo ""
echo "  Deployment complete."
echo "  Set your frontend WS_URL to the Cloud Run URL printed above."
echo ""
