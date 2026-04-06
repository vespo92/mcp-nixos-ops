#!/usr/bin/env bash
# nixops-agent: Publishes node telemetry to NATS for mcp-nixos-ops cache.
# Runs as a systemd service on each NixOS node.
#
# Requires: natscli (nats CLI), coreutils, zpool/zfs (optional)
# Config via environment: NATS_URL, NIXOPS_NODE_NAME, NIXOPS_ZFS_POOLS

set -euo pipefail

NATS_URL="${NATS_URL:-nats://localhost:4222}"
NODE_NAME="${NIXOPS_NODE_NAME:-$(hostname)}"
ZFS_POOLS="${NIXOPS_ZFS_POOLS:-}"   # Comma-separated pool names
HEARTBEAT_INTERVAL=30
STATUS_INTERVAL=60
ZFS_INTERVAL=60
GEN_INTERVAL=300

log() { echo "[nixops-agent] $*" >&2; }
ts() { date +%s%3N; }

publish() {
  local subject="$1"
  local payload="$2"
  nats pub --server="$NATS_URL" "$subject" "$payload" 2>/dev/null || log "WARN: failed to publish $subject"
}

collect_heartbeat() {
  local up
  up=$(awk '{print int($1)}' /proc/uptime)
  local ver
  ver=$(nixos-version 2>/dev/null || echo "unknown")
  printf '{"ts":%s,"up":%s,"version":"%s"}' "$(ts)" "$up" "$ver"
}

collect_status() {
  local ver up gen mem_json disk_json failed k3s_active k3s_nodes

  ver=$(nixos-version 2>/dev/null || echo "unknown")
  up=$(uptime 2>/dev/null || echo "unknown")
  gen=$(readlink /nix/var/nix/profiles/system 2>/dev/null || echo "unknown")

  # Memory
  local total used free available
  read -r total used free _ _ _ available < <(free -h | awk '/^Mem:/{print $2,$3,$4,$7}')
  mem_json=$(printf '{"total":"%s","used":"%s","free":"%s","available":"%s"}' \
    "${total:-?}" "${used:-?}" "${free:-?}" "${available:-?}")

  # Disk
  local root_disk nix_disk
  root_disk=$(df -h / 2>/dev/null | awk 'NR==2{print $0}' || echo "?")
  nix_disk=$(df -h /nix 2>/dev/null | awk 'NR==2{print $0}' || echo "")
  disk_json=$(printf '{"root":"%s","nix":"%s"}' "$root_disk" "$nix_disk")

  # Failed services
  local failed_list
  failed_list=$(systemctl --failed --no-pager --no-legend 2>/dev/null | head -5 || echo "")
  local failed_json="[]"
  if [ -n "$failed_list" ]; then
    failed_json=$(echo "$failed_list" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")
  fi

  # K3s
  k3s_active="false"
  k3s_nodes=""
  if systemctl is-active k3s >/dev/null 2>&1; then
    k3s_active="true"
    k3s_nodes=$(sudo k3s kubectl get nodes --no-headers 2>/dev/null || echo "")
  fi

  printf '{"ts":%s,"version":"%s","uptime":"%s","generation":"%s","memory":%s,"disk":%s,"failedServices":%s,"k3s":{"active":%s,"nodes":"%s"}}' \
    "$(ts)" "$ver" "$up" "$gen" "$mem_json" "$disk_json" "$failed_json" "$k3s_active" "$k3s_nodes"
}

collect_zfs() {
  local pools_json="["
  local first=true

  IFS=',' read -ra POOLS <<< "$ZFS_POOLS"
  for pool in "${POOLS[@]}"; do
    [ -z "$pool" ] && continue

    local imported=true health="UNKNOWN" cap=0 size="" alloc="" free="" scrub=""

    if ! sudo zpool list "$pool" -H >/dev/null 2>&1; then
      imported=false
      [ "$first" = false ] && pools_json+=","
      pools_json+=$(printf '{"name":"%s","imported":false,"health":"NOT_IMPORTED","capacityPct":0,"size":"","alloc":"","free":"","scrub":""}' "$pool")
      first=false
      continue
    fi

    read -r _ size alloc free _ _ _ cap health _ < <(sudo zpool list -H "$pool" 2>/dev/null)
    cap="${cap%%%}"  # Strip % sign
    scrub=$(sudo zpool status "$pool" 2>/dev/null | grep -E 'scan:' | head -1 | sed 's/^[[:space:]]*//' || echo "")

    local healthy_check
    healthy_check=$(sudo zpool status -x "$pool" 2>/dev/null || echo "")
    if echo "$healthy_check" | grep -q "is healthy"; then
      health="ONLINE"
    fi

    [ "$first" = false ] && pools_json+=","
    pools_json+=$(printf '{"name":"%s","imported":true,"health":"%s","capacityPct":%s,"size":"%s","alloc":"%s","free":"%s","scrub":"%s"}' \
      "$pool" "$health" "${cap:-0}" "$size" "$alloc" "$free" "$scrub")
    first=false
  done

  pools_json+="]"

  # Datasets
  local datasets=""
  IFS=',' read -ra POOLS <<< "$ZFS_POOLS"
  for pool in "${POOLS[@]}"; do
    [ -z "$pool" ] && continue
    local ds
    ds=$(sudo zfs list -r -o name,used,avail,mountpoint "$pool" 2>/dev/null | head -20 || echo "")
    [ -n "$ds" ] && datasets+="$ds\n"
  done

  printf '{"ts":%s,"pools":%s,"datasets":"%s"}' "$(ts)" "$pools_json" "$(echo -e "$datasets" | sed 's/"/\\"/g' | tr '\n' '|' | sed 's/|/\\n/g')"
}

collect_generations() {
  local current gens_json="["
  current=$(readlink /nix/var/nix/profiles/system 2>/dev/null || echo "unknown")

  local first=true
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local id date is_current="false"
    id=$(echo "$line" | awk '{print $1}')
    date=$(echo "$line" | awk '{print $2, $3}')
    echo "$line" | grep -q "(current)" && is_current="true"

    [ "$first" = false ] && gens_json+=","
    gens_json+=$(printf '{"id":%s,"date":"%s","current":%s}' "$id" "$date" "$is_current")
    first=false
  done < <(sudo nix-env --list-generations --profile /nix/var/nix/profiles/system 2>/dev/null | tail -20)

  gens_json+="]"
  printf '{"ts":%s,"current":"%s","generations":%s}' "$(ts)" "$current" "$gens_json"
}

# Main loop
log "Starting nixops-agent for node=$NODE_NAME nats=$NATS_URL pools=$ZFS_POOLS"

heartbeat_counter=0
status_counter=0
zfs_counter=0
gen_counter=0

while true; do
  # Heartbeat (every 30s)
  if (( heartbeat_counter % HEARTBEAT_INTERVAL == 0 )); then
    publish "nixops.heartbeat.$NODE_NAME" "$(collect_heartbeat)"
  fi

  # Status (every 60s)
  if (( status_counter % STATUS_INTERVAL == 0 )); then
    publish "nixops.status.$NODE_NAME" "$(collect_status)"
  fi

  # ZFS (every 60s, only if pools configured)
  if [ -n "$ZFS_POOLS" ] && (( zfs_counter % ZFS_INTERVAL == 0 )); then
    publish "nixops.zfs.$NODE_NAME" "$(collect_zfs)"
  fi

  # Generations (every 300s)
  if (( gen_counter % GEN_INTERVAL == 0 )); then
    publish "nixops.generations.$NODE_NAME" "$(collect_generations)"
  fi

  sleep 1
  heartbeat_counter=$((heartbeat_counter + 1))
  status_counter=$((status_counter + 1))
  zfs_counter=$((zfs_counter + 1))
  gen_counter=$((gen_counter + 1))
done
