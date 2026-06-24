import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ["ejm0fc-195-133-243-226.ru.tuna.am", "br.ru.tuna.am"],
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  }
});
