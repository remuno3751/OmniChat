#!/usr/bin/env node
import { main, realIo } from "../src/main.mjs";

// Let the event loop drain on its own: calling process.exit() while a WebSocket or
// keep-alive socket is closing trips a libuv assertion on Windows.
process.exitCode = await main(process.argv.slice(2), { env: process.env, io: realIo() });
