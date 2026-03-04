#!/usr/bin/env bash
# ── Prism QA — Cloud Run Deployment ─────────────────────────────────────────
# Run from the backend/ directory.
# Requires: gcloud CLI authenticated + billing-enabled project set.
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
  --allow-unauthenticated

echo ""
echo "  Deployment complete."
echo "  Set your frontend WS_URL to the Cloud Run URL printed above."
echo ""
