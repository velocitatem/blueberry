import { app, BrowserWindow } from "electron";
import { electronApp } from "@electron-toolkit/utils";
import { Window } from "./Window";
import { AppMenu } from "./Menu";
import { EventRegistry } from "./ipc/EventRegistry";
import { registerWindowEvents } from "./ipc/registerWindowEvents";
import { createKafkaEventPublisher } from "./kafka";
import { createLogger } from "./logger";
import { EventTail, composeSinks } from "./eventTail";

const log = createLogger("app");

let mainWindow: Window | null = null;
let menu: AppMenu | null = null;
const kafkaEventPublisher = createKafkaEventPublisher();
const eventTail = new EventTail();
const eventSink = composeSinks(kafkaEventPublisher.publish, eventTail.sink);

/** App-wide IPC registry; tracks channels this app registered for safe teardown. */
export let appEventRegistry: EventRegistry | null = null;

const createWindow = (): Window => {
  appEventRegistry?.cleanup();

  appEventRegistry = appEventRegistry ?? new EventRegistry(eventSink);
  // lets us extensably in the future manage new tabs and windows

  const window = new Window(eventSink);
  menu = new AppMenu(window);
  registerWindowEvents(appEventRegistry, window, eventTail);
  return window;
};

const connectKafkaEvents = (): void => {
  void kafkaEventPublisher.connect();
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");
  log.info("Application starting");

  mainWindow = createWindow();
  connectKafkaEvents();

  app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
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
