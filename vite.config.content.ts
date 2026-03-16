import { defineConfig } from "vite";
import path from "path";

// Build content.js separately using ES module format
// (imported via manifest "type": "module")

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: { content: path.resolve(__dirname, "src/content/content.ts") },
      output: { entryFileNames: "content.js", format: "es" },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
