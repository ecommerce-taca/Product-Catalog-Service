#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Script: mongo-init.sh
# Purpose: Idempotent initialization of single-node MongoDB replica set (rs0)
# Reference: Task OPS-B01, tensura/docs/database-design.md §9.1
# ==============================================================================

MONGO_HOST="${MONGODB_HOST:-mongodb}"
MONGO_PORT="${MONGODB_PORT:-27017}"
REPLICA_SET_NAME="${REPLICA_SET_NAME:-rs0}"

echo "[mongo-init] Starting replica set initialization script..."
echo "[mongo-init] Target MongoDB instance: ${MONGO_HOST}:${MONGO_PORT}"
echo "[mongo-init] Target replica set name: ${REPLICA_SET_NAME}"

# Wait for MongoDB to accept connections
MAX_ATTEMPTS=30
RETRY_DELAY=2
ATTEMPT=0

echo "[mongo-init] Waiting for MongoDB to become ready..."
until mongosh --host "${MONGO_HOST}" --port "${MONGO_PORT}" --eval "db.adminCommand('ping')" --quiet > /dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]; then
    echo "[mongo-init] ERROR: MongoDB at ${MONGO_HOST}:${MONGO_PORT} unreachable after ${MAX_ATTEMPTS} attempts." >&2
    exit 1
  fi
  echo "[mongo-init] MongoDB not ready yet (attempt ${ATTEMPT}/${MAX_ATTEMPTS}). Retrying in ${RETRY_DELAY}s..."
  sleep "${RETRY_DELAY}"
done

echo "[mongo-init] MongoDB connection verified successfully."

# Check if replica set is already initiated (idempotency check)
RS_STATUS=$(mongosh --host "${MONGO_HOST}" --port "${MONGO_PORT}" --quiet --eval "try { rs.status().ok } catch(e) { 0 }")

if [ "${RS_STATUS}" = "1" ]; then
  echo "[mongo-init] Replica set '${REPLICA_SET_NAME}' is already initiated and active (rs.status().ok === 1). Skipping initiation."
else
  echo "[mongo-init] Replica set '${REPLICA_SET_NAME}' is not initiated. Initiating single-node replica set..."
  INIT_RESULT=$(mongosh --host "${MONGO_HOST}" --port "${MONGO_PORT}" --quiet --eval "rs.initiate({ _id: '${REPLICA_SET_NAME}', members: [{ _id: 0, host: '${MONGO_HOST}:${MONGO_PORT}' }] })")
  echo "[mongo-init] rs.initiate() result: ${INIT_RESULT}"
fi

# Wait for PRIMARY or SECONDARY state to stabilize
echo "[mongo-init] Waiting for replica set member state to stabilize..."
STABILIZE_ATTEMPTS=15
STABILIZE_COUNT=0
while true; do
  IS_READY=$(mongosh --host "${MONGO_HOST}" --port "${MONGO_PORT}" --quiet --eval "try { const hello = db.hello(); hello.isWritablePrimary || hello.secondary ? 1 : 0 } catch(e) { 0 }")
  if [ "${IS_READY}" = "1" ]; then
    echo "[mongo-init] Replica set node is ready and accepting operations."
    break
  fi
  STABILIZE_COUNT=$((STABILIZE_COUNT + 1))
  if [ "${STABILIZE_COUNT}" -ge "${STABILIZE_ATTEMPTS}" ]; then
    echo "[mongo-init] WARNING: Timed out waiting for primary/secondary status, but initiate command was dispatched."
    break
  fi
  sleep 1
done

echo "[mongo-init] Replica set initialization process completed."
