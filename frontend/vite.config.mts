import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served over HTTPS on the tailnet (`tailscale serve --https=8793`): Seal needs
  // crypto.subtle, which browsers only expose on https or localhost.
  server: { allowedHosts: [".ts.net"] },
});
