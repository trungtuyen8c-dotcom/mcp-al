// index.ts — entry point. Selects the transport from env MCP_TRANSPORT (http | stdio).
import { loadConfig } from './config.js'
import { startHttp } from './http.js'
import { startStdio } from './stdio.js'

const cfg = loadConfig()
if (cfg.transport === 'stdio') await startStdio(cfg)
else await startHttp(cfg)
