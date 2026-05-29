import { app, BrowserWindow } from "electron";
import { electronApp } from "@electron-toolkit/utils";
import { Window } from "./Window";
import { AppMenu } from "./Menu";
import { EventRegistry } from "./ipc/EventRegistry";
import { registerWindowEvents } from "./ipc/registerWindowEvents";
import { createKafkaEventPublisher } from "./kafka";
import { createLogger } from "./logger";
import { composeSinks } from "./eventTail";
import { FileSessionLog } from "./SessionLog";

const log = createLogger("app");

let mainWindow: Window | null = null;
let menu: AppMenu | null = null;
const kafkaEventPublisher = createKafkaEventPublisher();

/** App-wide IPC registry; tracks channels this app registered for safe teardown. */
export let appEventRegistry: EventRegistry | null = null;

const createWindow = (sessionLog: FileSessionLog): Window => {
  const eventSink = composeSinks(kafkaEventPublisher.publish, sessionLog.sink);
  appEventRegistry?.cleanup();

  appEventRegistry = appEventRegistry ?? new EventRegistry(eventSink);

  const window = new Window(eventSink);
  menu = new AppMenu(window);
  registerWindowEvents(appEventRegistry, window, sessionLog);
  return window;
};

const connectKafkaEvents = (): void => {
  void kafkaEventPublisher.connect();
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");
  log.info("Application starting");

  const sessionLog = FileSessionLog.load();
  mainWindow = createWindow(sessionLog);
  connectKafkaEvents();

  app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(sessionLog);
    }
  });
});

app.on("before-quit", () => {
  void kafkaEventPublisher.disconnect();
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
