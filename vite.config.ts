import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.ADMIN_UI_DEV_PORT || 5173),
    strictPort: true,
    cors: true
  },
  build: {
    outDir: "dist/admin-ui",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/admin-ui/main.tsx",
      output: {
        entryFileNames: "assets/admin-ui.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const names = "names" in assetInfo && Array.isArray(assetInfo.names) ? assetInfo.names : [];
          const name = assetInfo.name ?? names[0] ?? "";
          return name.endsWith(".css") ? "assets/admin-ui.css" : "assets/[name][extname]";
        }
      }
    }
  }
});
