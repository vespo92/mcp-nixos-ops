# NixOS module for the nixops-agent systemd service.
# Publishes node telemetry to NATS for mcp-nixos-ops cache-first reads.
#
# Usage in configuration.nix:
#   imports = [ ./agent.nix ];
#   services.nixops-agent = {
#     enable = true;
#     natsUrl = "nats://10.0.16.10:4222";  # Your NATS server
#     zfsPools = [ "tank" ];                 # Pools to monitor
#   };

{ config, lib, pkgs, ... }:

let
  cfg = config.services.nixops-agent;
in
{
  options.services.nixops-agent = {
    enable = lib.mkEnableOption "nixops-agent telemetry publisher";

    natsUrl = lib.mkOption {
      type = lib.types.str;
      default = "nats://localhost:4222";
      description = "NATS server URL";
    };

    nodeName = lib.mkOption {
      type = lib.types.str;
      default = config.networking.hostName;
      description = "Node name (defaults to hostname)";
    };

    zfsPools = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "ZFS pools to monitor";
    };

    agentScript = lib.mkOption {
      type = lib.types.path;
      default = ./agent.sh;
      description = "Path to the agent shell script";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ pkgs.natscli ];

    systemd.services.nixops-agent = {
      description = "nixops-agent: NixOS telemetry publisher for mcp-nixos-ops";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "nss-lookup.target" ];
      wants = [ "network-online.target" ];

      environment = {
        NATS_URL = cfg.natsUrl;
        NIXOPS_NODE_NAME = cfg.nodeName;
        NIXOPS_ZFS_POOLS = lib.concatStringsSep "," cfg.zfsPools;
      };

      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.bash}/bin/bash ${cfg.agentScript}";
        Restart = "always";
        RestartSec = 5;

        # Security hardening
        DynamicUser = false;  # Needs sudo for zpool/k3s
        ProtectSystem = "strict";
        ReadOnlyPaths = [ "/" ];
        ProtectHome = true;
        NoNewPrivileges = false;  # Needs sudo
        PrivateTmp = true;

        # Logging
        StandardOutput = "journal";
        StandardError = "journal";
        SyslogIdentifier = "nixops-agent";
      };
    };

    # Sudoers rules for the agent (zpool, zfs, k3s, nix-env)
    security.sudo.extraRules = [
      {
        commands = [
          { command = "${pkgs.zfs}/bin/zpool"; options = [ "NOPASSWD" ]; }
          { command = "${pkgs.zfs}/bin/zfs"; options = [ "NOPASSWD" ]; }
          { command = "/run/current-system/sw/bin/k3s"; options = [ "NOPASSWD" ]; }
          { command = "${pkgs.nix}/bin/nix-env"; options = [ "NOPASSWD" ]; }
        ];
        groups = [ "nixops-agent" ];
      }
    ];
  };
}
