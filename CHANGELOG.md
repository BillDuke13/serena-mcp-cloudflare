# Changelog

All notable changes to this repository will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for tagged releases.

## [0.1.0] - 2026-02-22

### Added

- Cloudflare Workers + Containers deployment wrapper for Serena MCP
- Bearer token auth with constant-time comparison
- Multi-terminal routing by token (`API_TOKENS_JSON`)
- R2 snapshot persistence (local `SERENA_HOME` + periodic snapshot sync)
- `notifications/initialized` compatibility shim for affected MCP clients
- Cloudflare deployment and operations guide

### Changed

- Open-source-safe default configuration in `wrangler.toml`
- Documentation for token routing, rollouts, and R2 snapshot behavior
