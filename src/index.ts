#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./createServer.js";

const apiKey = process.env.MCP_AL_API_KEY;
if (!apiKey) {
  throw new Error("Thiếu MCP_AL_API_KEY - tạo API key ở /api/api-keys (đăng nhập bằng JWT) rồi đặt vào biến môi trường.");
}

const server = createMcpServer({ apiKey, baseUrl: process.env.MCP_AL_BASE_URL });
const transport = new StdioServerTransport();
await server.connect(transport);
