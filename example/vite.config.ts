import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "../",
  plugins: [react()],
  // The /connect consent page must not be framed (clickjacking). Set the same
  // header wherever you host the frontend in production.
  server: { headers: { "Content-Security-Policy": "frame-ancestors 'none'" } },
  preview: { headers: { "Content-Security-Policy": "frame-ancestors 'none'" } },
  resolve: {
    conditions: ["@convex-dev/component-source"],
  },
});
