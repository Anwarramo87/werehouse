#!/bin/sh
# Container entrypoint.
#
# ROLE selects what this container is, so the same image serves both processes
# on Railway rather than needing two builds:
#
#   api     (default) — the HTTP server
#   worker            — the BullMQ payroll worker
#
# Why the worker matters: PayrollService checks for a connected worker before
# queueing, finds none, and falls back to running the payroll INLINE on the API
# event loop. A 300-employee run then blocks every other request for its whole
# duration. Deploying this image a second time with ROLE=worker is what makes
# the queue real.
set -e

case "${ROLE:-api}" in
  worker)
    echo "Starting payroll worker (node dist/payroll-worker)…"
    exec node dist/payroll-worker
    ;;
  api)
    echo "Starting API (node dist/main)…"
    exec node dist/main
    ;;
  *)
    echo "Unknown ROLE='${ROLE}'. Use 'api' or 'worker'." >&2
    exit 1
    ;;
esac
