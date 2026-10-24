// Serve LiteRT.js's Wasm runtime from this app instead of an unpinned CDN,
// so the demo matches the installed @litertjs/core and works offline once the model is cached.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("public/litert", { recursive: true });
cpSync("node_modules/@litertjs/core/wasm", "public/litert", { recursive: true });
