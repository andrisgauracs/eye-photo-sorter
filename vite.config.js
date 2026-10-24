import { defineConfig } from "vite";

// Cross-origin isolation lets LiteRT.js use its threaded WebAssembly build when WebGPU isn't available.
// "credentialless" keeps Google Fonts and the Hugging Face model download working without CORP headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  // The Eye SDK top-level awaits its Wasm core and loads EyeWeb.wasm via import.meta.url,
  // so it must not be pre-bundled.
  optimizeDeps: {
    exclude: ["@desert-ant-labs/eye", "@desert-ant-labs/core", "@litertjs/core"],
    include: ["@bjorn3/browser_wasi_shim"],
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
});
