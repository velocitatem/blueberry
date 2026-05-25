import { app, BrowserWindow } from "electron";
import { electronApp } from "@electron-toolkit/utils";
import { Window } from "./Window";
import { AppMenu } from "./Menu";
import { EventRegistry } from "./ipc/EventRegistry";
import { registerWindowEvents } from "./ipc/registerWindowEvents";

let mainWindow: Window | null = null;
let menu: AppMenu | null = null;

/** App-wide IPC registry; tracks channels this app registered for safe teardown. */
export let appEventRegistry: EventRegistry | null = null;

const createWindow = (): Window => {
  appEventRegistry?.cleanup();

  appEventRegistry = appEventRegistry ?? new EventRegistry();
  // lets us extensably in the future manage new tabs and windows

  const window = new Window();
  menu = new AppMenu(window);
  registerWindowEvents(appEventRegistry, window);
  return window;
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  mainWindow = createWindow();

  app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  appEventRegistry?.cleanup();
  appEventRegistry = null;

  if (mainWindow) {
    mainWindow = null;
  }
  if (menu) {
    menu = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
