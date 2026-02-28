import { defineConfig } from "vite";
import path from "path";

// Build content.js and chatgptBridge.js separately to use different output formats:
// - content.js: ES module (imported via manifest "type": "module")
// - chatgptBridge.js: IIFE (fully self-contained, no global variable collisions)

const isContentBuild = process.env.BUILD_TARGET === "content";
const isBridgeBuild = process.env.BUILD_TARGET === "bridge";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: isContentBuild
      ? {
          input: { content: path.resolve(__dirname, "src/content/content.ts") },
          output: { entryFileNames: "content.js", format: "es" },
        }
      : {
          input: {
            chatgptBridge: path.resolve(
              __dirname,
              "src/content/chatgptBridge.ts",
            ),
          },
          output: {
            entryFileNames: "chatgptBridge.js",
            format: "iife",
            name: "FlowRecorderBridge",
          },
        },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
