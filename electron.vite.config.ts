import { copyFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const PAGE_STATE_SCRIPT = resolve(
  __dirname,
  "src/main/scripts/page-state.js",
);

const copyPageStateScript = (): Plugin => ({
  name: "copy-page-state-script",
  closeBundle() {
    const dest = resolve(__dirname, "out/main/scripts/page-state.js");
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(PAGE_STATE_SCRIPT, dest);
  },
});

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPageStateScript()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          topbar: resolve(__dirname, "src/preload/topbar.ts"),
          sidebar: resolve(__dirname, "src/preload/sidebar.ts"),
          tab: resolve(__dirname, "src/preload/tab.ts"),
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: {
          topbar: resolve(__dirname, "src/renderer/topbar/index.html"),
          sidebar: resolve(__dirname, "src/renderer/sidebar/index.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@common": resolve("src/renderer/common"),
      },
    },
    plugins: [react()],
    server: {
      fs: {
        allow: [".."],
      },
    },
  },
});
