import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/discover": "http://localhost:8000",
      "/discover-stream": "http://localhost:8000",
      "/verify-agent-stream": "http://localhost:8000",
      "/verify-agent": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
});
