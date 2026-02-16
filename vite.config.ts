import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// Plugin: copy built popup HTML and manifest.json to dist root
function copyPopupAndManifestPlugin() {
  return {
    name: "copy-popup-and-manifest",
    closeBundle() {
      try {
        const distDir = path.resolve(__dirname, "dist");

        const builtPopup = path.resolve(distDir, "src/popup/popup.html");
        const destPopup = path.resolve(distDir, "popup.html");

        if (fs.existsSync(builtPopup)) {
          fs.copyFileSync(builtPopup, destPopup);
          console.log("[vite-plugin] copied popup.html to dist root");
        }

        const srcManifest = path.resolve(__dirname, "public/manifest.json");
        const destManifest = path.resolve(distDir, "manifest.json");
        if (fs.existsSync(srcManifest)) {
          fs.copyFileSync(srcManifest, destManifest);
          console.log("[vite-plugin] copied manifest.json to dist root");
        }

        const srcDir = path.resolve(distDir, "src");
        if (fs.existsSync(srcDir)) {
          fs.rmSync(srcDir, { recursive: true });
          console.log("[vite-plugin] removed src directory from dist");
        }
      } catch (err) {
        console.error("[vite-plugin] error copying popup or manifest", err);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyPopupAndManifestPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, "src/popup/popup.html"),
        background: path.resolve(__dirname, "src/background/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
