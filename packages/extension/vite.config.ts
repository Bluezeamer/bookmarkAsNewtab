import { defineConfig } from "vite";

// MV3: 双入口 —— newtab 页(html) + service worker(单 es bundle)
// chrome 91+ 的 service worker 支持 ES module; manifest 从 public/ 直拷
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        newtab: "newtab.html",
        popup: "popup.html",
        sw: "src/sw/index.ts",
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
      },
    },
  },
});
