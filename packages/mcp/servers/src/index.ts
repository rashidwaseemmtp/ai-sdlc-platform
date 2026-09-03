/**
 * @sdlc/mcp-servers — the MCP servers this platform ships.
 *
 * Product, BA and Filesystem are real stdio servers (see the `bin` entries in package.json).
 * GitHub, Figma and Playwright ship as in-process mocks until credentials are configured;
 * swapping in the real servers is a change to config/mcp.yaml, not a code change.
 */

export * from './mocks/index.js';
