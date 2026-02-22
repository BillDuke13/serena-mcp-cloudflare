#!/usr/bin/env bash
set -euo pipefail

SERVER_PID=""
SYNC_LOOP_PID=""
R2_SNAPSHOT_ACTIVE=0
R2_ENDPOINT=""
R2_BUCKET=""
R2_PREFIX=""
SNAPSHOT_LOCK_DIR=""

log() {
  printf '[serena-entrypoint] %s\n' "$*" >&2
}

warn() {
  printf '[serena-entrypoint][warn] %s\n' "$*" >&2
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

strict_r2_mode_enabled() {
  is_truthy "${SERENA_R2_STATE_STRICT:-0}"
}

r2_snapshot_requested() {
  if is_truthy "${SERENA_R2_SNAPSHOT_ENABLED:-0}"; then
    return 0
  fi
  is_truthy "${SERENA_R2_STATE_ENABLED:-0}"
}

r2_snapshot_prefix() {
  # Build the effective object prefix used for snapshot restore/sync.
  # In multi-terminal mode we append a stable per-container partition key so
  # independently routed terminals do not overwrite each other's snapshots.
  local base_prefix partition_mode partition_key
  if [[ -n "${SERENA_R2_SNAPSHOT_PREFIX:-}" ]]; then
    base_prefix="${SERENA_R2_SNAPSHOT_PREFIX}"
  else
    base_prefix="${SERENA_R2_STATE_PREFIX:-serena-mcp/default/serena-home}"
  fi

  partition_mode="${SERENA_R2_STATE_PARTITION_MODE:-none}"
  case "${partition_mode}" in
    none|"")
      printf '%s' "${base_prefix}"
      return 0
      ;;
    durable-object)
      partition_key="${CLOUDFLARE_DURABLE_OBJECT_ID:-}"
      if [[ -z "${partition_key}" ]]; then
        warn "SERENA_R2_STATE_PARTITION_MODE=durable-object but CLOUDFLARE_DURABLE_OBJECT_ID is missing; falling back to unpartitioned prefix"
        printf '%s' "${base_prefix}"
        return 0
      fi
      partition_key="$(printf '%s' "${partition_key}" | tr -c 'A-Za-z0-9._-' '_')"
      printf '%s/%s' "${base_prefix}" "${partition_key}"
      return 0
      ;;
    *)
      warn "Unknown SERENA_R2_STATE_PARTITION_MODE=${partition_mode}; falling back to unpartitioned prefix"
      printf '%s' "${base_prefix}"
      return 0
      ;;
  esac
}

snapshot_interval_seconds() {
  local raw="${SERENA_R2_SNAPSHOT_INTERVAL_SECONDS:-180}"
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${raw}"
    return 0
  fi
  printf '180'
}

snapshot_retention_count() {
  local raw="${SERENA_R2_SNAPSHOT_RETENTION_COUNT:-5}"
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${raw}"
    return 0
  fi
  printf '5'
}

disable_r2_snapshots() {
  R2_SNAPSHOT_ACTIVE=0
}

fail_or_degrade_r2() {
  local message="$1"
  if strict_r2_mode_enabled; then
    log "${message}"
    exit 1
  fi

  warn "${message}"
  warn "Disabling R2 snapshot sync and continuing with local state only"
  disable_r2_snapshots
}

bootstrap_serena_home() {
  local target_home="$1"
  mkdir -p "${target_home}"

  if [[ ! -f "${target_home}/serena_config.yml" ]]; then
    cp /app/serena/src/serena/resources/serena_config.template.yml \
      "${target_home}/serena_config.yml"
  fi

  sed -i 's/^gui_log_window: .*/gui_log_window: False/' \
    "${target_home}/serena_config.yml"
  sed -i 's/^web_dashboard: .*/web_dashboard: False/' \
    "${target_home}/serena_config.yml"
  sed -i 's/^web_dashboard_listen_address: .*/web_dashboard_listen_address: 0.0.0.0/' \
    "${target_home}/serena_config.yml"
  sed -i 's/^web_dashboard_open_on_launch: .*/web_dashboard_open_on_launch: False/' \
    "${target_home}/serena_config.yml"
}

prepare_r2_snapshot_if_enabled() {
  if ! r2_snapshot_requested; then
    log "R2 snapshot sync disabled; using local SERENA_HOME=${SERENA_HOME:-/app/.serena}"
    return 0
  fi

  if ! command -v aws >/dev/null 2>&1; then
    fail_or_degrade_r2 "R2 snapshot sync requested but aws CLI is not installed"
    return 0
  fi

  local missing=()
  [[ -n "${AWS_ACCESS_KEY_ID:-}" ]] || missing+=("AWS_ACCESS_KEY_ID")
  [[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || missing+=("AWS_SECRET_ACCESS_KEY")
  [[ -n "${R2_ACCOUNT_ID:-}" ]] || missing+=("R2_ACCOUNT_ID")
  [[ -n "${R2_BUCKET_NAME:-}" ]] || missing+=("R2_BUCKET_NAME")
  if (( ${#missing[@]} > 0 )); then
    fail_or_degrade_r2 "R2 snapshot sync requested but missing variables: ${missing[*]}"
    return 0
  fi

  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
  export AWS_EC2_METADATA_DISABLED=true

  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  R2_BUCKET="${R2_BUCKET_NAME}"
  R2_PREFIX="$(r2_snapshot_prefix)"
  SNAPSHOT_LOCK_DIR="/tmp/serena-r2-snapshot-$(printf '%s' "${R2_PREFIX}" | tr '/:' '__').lock"
  R2_SNAPSHOT_ACTIVE=1

  log "R2 snapshot sync configured (endpoint=${R2_ENDPOINT}, bucket=${R2_BUCKET}, prefix=${R2_PREFIX})"
}

r2_s3_uri() {
  local key="$1"
  printf 's3://%s/%s' "${R2_BUCKET}" "${key}"
}

aws_s3() {
  AWS_PAGER="" aws --endpoint-url "${R2_ENDPOINT}" --region "${AWS_DEFAULT_REGION:-auto}" s3 "$@"
}

restore_serena_home_from_r2() {
  local target_home="$1"
  if (( R2_SNAPSHOT_ACTIVE != 1 )); then
    return 0
  fi

  local latest_tmp snapshot_name archive_tmp restore_dir snapshot_key
  latest_tmp="$(mktemp /tmp/serena-r2-latest.XXXXXX)"
  archive_tmp=""
  restore_dir=""

  if ! aws_s3 cp "$(r2_s3_uri "${R2_PREFIX}/LATEST")" "${latest_tmp}" >/dev/null 2>&1; then
    rm -f "${latest_tmp}"
    log "No R2 snapshot manifest found; starting with fresh local SERENA_HOME"
    return 0
  fi

  snapshot_name="$(tr -d '\r\n' < "${latest_tmp}" || true)"
  rm -f "${latest_tmp}"
  if [[ -z "${snapshot_name}" ]]; then
    fail_or_degrade_r2 "R2 snapshot manifest (LATEST) is empty"
    return 0
  fi

  snapshot_key="${R2_PREFIX}/snapshots/${snapshot_name}"
  archive_tmp="$(mktemp /tmp/serena-r2-restore.XXXXXX.tar.gz)"
  if ! aws_s3 cp "$(r2_s3_uri "${snapshot_key}")" "${archive_tmp}" >/dev/null 2>&1; then
    rm -f "${archive_tmp}"
    fail_or_degrade_r2 "Failed to download R2 snapshot ${snapshot_key}"
    return 0
  fi

  restore_dir="$(mktemp -d /tmp/serena-restore.XXXXXX)"
  if ! tar -xzf "${archive_tmp}" -C "${restore_dir}"; then
    rm -f "${archive_tmp}"
    rm -rf "${restore_dir}"
    fail_or_degrade_r2 "Failed to extract snapshot ${snapshot_name}"
    return 0
  fi

  mkdir -p "${target_home}"
  if ! tar -C "${restore_dir}" -cf - . | tar -C "${target_home}" -xf -; then
    rm -f "${archive_tmp}"
    rm -rf "${restore_dir}"
    fail_or_degrade_r2 "Failed to restore snapshot into ${target_home}"
    return 0
  fi

  rm -f "${archive_tmp}"
  rm -rf "${restore_dir}"
  log "Restored Serena state from R2 snapshot ${snapshot_name}"
}

release_snapshot_lock() {
  if [[ -n "${SNAPSHOT_LOCK_DIR}" ]]; then
    rmdir "${SNAPSHOT_LOCK_DIR}" 2>/dev/null || true
  fi
}

prune_old_snapshots() {
  if (( R2_SNAPSHOT_ACTIVE != 1 )); then
    return 0
  fi

  local keep index key
  keep="$(snapshot_retention_count)"
  if (( keep <= 0 )); then
    return 0
  fi

  index=0
  while IFS= read -r key; do
    [[ -n "${key}" ]] || continue
    index=$((index + 1))
    if (( index > keep )); then
      aws_s3 rm "$(r2_s3_uri "${R2_PREFIX}/snapshots/${key}")" >/dev/null 2>&1 || true
    fi
  done < <(
    aws_s3 ls "$(r2_s3_uri "${R2_PREFIX}/snapshots/")" 2>/dev/null \
      | awk '{print $4}' \
      | grep '^serena-home-.*\.tar\.gz$' \
      | sort -r
  )
}

snapshot_serena_home_to_r2() {
  local reason="${1:-periodic}"
  if (( R2_SNAPSHOT_ACTIVE != 1 )); then
    return 0
  fi

  # A simple process-local lock prevents overlapping periodic/shutdown snapshots
  # inside the same container. Cross-container write isolation is handled by
  # token routing plus the partitioned R2 prefix.
  if ! mkdir "${SNAPSHOT_LOCK_DIR}" 2>/dev/null; then
    log "Skipping ${reason} snapshot; another snapshot is already running"
    return 0
  fi

  local target_home tmp_archive tmp_latest snapshot_name ts
  target_home="${SERENA_HOME:-/app/.serena}"
  tmp_archive=""
  tmp_latest=""

  if [[ ! -d "${target_home}" ]]; then
    warn "Skipping ${reason} snapshot; SERENA_HOME does not exist: ${target_home}"
    release_snapshot_lock
    return 0
  fi

  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  snapshot_name="serena-home-${ts}-${RANDOM}.tar.gz"
  tmp_archive="$(mktemp /tmp/serena-home-snapshot.XXXXXX.tar.gz)"
  if ! tar -C "${target_home}" -czf "${tmp_archive}" .; then
    warn "Failed to build ${reason} snapshot archive"
    rm -f "${tmp_archive}"
    release_snapshot_lock
    return 0
  fi

  if ! aws_s3 cp "${tmp_archive}" "$(r2_s3_uri "${R2_PREFIX}/snapshots/${snapshot_name}")" >/dev/null 2>&1; then
    warn "Failed to upload ${reason} snapshot to R2 (${snapshot_name})"
    rm -f "${tmp_archive}"
    release_snapshot_lock
    return 0
  fi

  tmp_latest="$(mktemp /tmp/serena-latest.XXXXXX)"
  printf '%s\n' "${snapshot_name}" > "${tmp_latest}"
  if ! aws_s3 cp "${tmp_latest}" "$(r2_s3_uri "${R2_PREFIX}/LATEST")" >/dev/null 2>&1; then
    warn "Failed to update R2 snapshot pointer (LATEST)"
    rm -f "${tmp_latest}" "${tmp_archive}"
    release_snapshot_lock
    return 0
  fi

  rm -f "${tmp_latest}" "${tmp_archive}"
  prune_old_snapshots
  release_snapshot_lock
  log "Uploaded ${reason} snapshot to R2 (${snapshot_name})"
}

start_snapshot_loop() {
  if (( R2_SNAPSHOT_ACTIVE != 1 )); then
    return 0
  fi

  local interval
  interval="$(snapshot_interval_seconds)"
  if (( interval <= 0 )); then
    log "R2 snapshot loop disabled (interval=${interval})"
    return 0
  fi

  (
    while true; do
      sleep "${interval}"
      snapshot_serena_home_to_r2 "periodic" || true
    done
  ) &
  SYNC_LOOP_PID=$!
  log "Started R2 snapshot loop (interval=${interval}s, retention=$(snapshot_retention_count))"
}

stop_snapshot_loop() {
  if [[ -n "${SYNC_LOOP_PID}" ]] && kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; then
    kill "${SYNC_LOOP_PID}" 2>/dev/null || true
    wait "${SYNC_LOOP_PID}" 2>/dev/null || true
  fi
  SYNC_LOOP_PID=""
}

shutdown_handler() {
  local signal="$1"
  local exit_code=0

  log "Received ${signal}; stopping Serena MCP server"
  stop_snapshot_loop

  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "-${signal}" "${SERVER_PID}" 2>/dev/null || kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" || exit_code=$?
  fi

  snapshot_serena_home_to_r2 "shutdown" || true
  exit "${exit_code}"
}

main() {
  export SERENA_HOME="${SERENA_LOCAL_STATE_DIR:-${SERENA_HOME:-/app/.serena}}"
  mkdir -p "${SERENA_HOME}"

  prepare_r2_snapshot_if_enabled
  restore_serena_home_from_r2 "${SERENA_HOME}"
  bootstrap_serena_home "${SERENA_HOME}"
  start_snapshot_loop

  log "Starting Serena MCP server with local SERENA_HOME=${SERENA_HOME}"
  "$@" &
  SERVER_PID=$!

  local exit_code=0
  wait "${SERVER_PID}" || exit_code=$?
  log "Serena MCP server exited with code ${exit_code}"

  stop_snapshot_loop
  snapshot_serena_home_to_r2 "shutdown" || true
  return "${exit_code}"
}

trap 'shutdown_handler TERM' TERM
trap 'shutdown_handler INT' INT

main "$@"
