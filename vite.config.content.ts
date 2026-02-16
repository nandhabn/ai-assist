import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false, // Do not empty the dist folder on this build
    rollupOptions: {
      input: {
        content: path.resolve(__dirname, "src/content/content.ts"),
      },
      output: {
        entryFileNames: "content.js",
        format: "es",
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
