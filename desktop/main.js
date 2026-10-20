const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createAppServer } = require("../server");

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download/windows";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3-coder";
const MODEL_CHOICES = ["qwen3-coder", "qwen3:1.7b"];
const OLLAMA_URL = new URL(process.env.OLLAMA_URL || "http://127.0.0.1:11434");
const OLLAMA_HOST = OLLAMA_URL.host;
const OLLAMA_API = OLLAMA_URL.toString().replace(/\/+$/, "");

if (process.platform !== "win32") {
  app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: "error",
      title: "Windows only",
      message: "Local Project Assistant is available for Windows only."
    });
    app.quit();
  });
} else {
  app.setAppUserModelId("com.localprojectassistant.windows");

  let mainWindow;
  let appServer;
  let appUrl;
  let ollamaProcess;
  let setupInProgress = false;
  let availableUpdate = false;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  function sendUpdateStatus(status) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update:status", status);
    }
  }

  async function checkForUpdates() {
    if (!app.isPackaged) {
      sendUpdateStatus({ state: "unavailable", message: "Updates are checked in the installed app." });
      return;
    }
    sendUpdateStatus({ state: "checking", message: "Checking GitHub for updates…" });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      sendUpdateStatus({ state: "error", message: `Update check failed: ${error.message}` });
    }
  }

  autoUpdater.on("checking-for-update", () => {
    sendUpdateStatus({ state: "checking", message: "Checking GitHub for updates…" });
  });
  autoUpdater.on("update-available", (info) => {
    availableUpdate = true;
    sendUpdateStatus({
      state: "available",
      version: info.version,
      message: `Version ${info.version} is ready to download.`
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    availableUpdate = false;
    sendUpdateStatus({
      state: "not-available",
      version: info.version,
      message: `You're up to date (v${app.getVersion()}).`
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus({
      state: "downloading",
      percent: Math.round(progress.percent),
      message: `Downloading update… ${Math.round(progress.percent)}%`
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendUpdateStatus({
      state: "downloaded",
      version: info.version,
      message: `Version ${info.version} is downloaded and ready to install.`
    });
  });
  autoUpdater.on("error", (error) => {
    sendUpdateStatus({ state: "error", message: `Update failed: ${error.message}` });
  });

  function sendSetupProgress(message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("setup:progress", message);
    }
  }

  function locateOllama() {
    try {
      const result = execFileSync("where.exe", ["ollama"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (result && fs.existsSync(result)) return result;
    } catch {
      // Check the standard per-user and machine-wide installer locations below.
    }

    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Ollama", "ollama.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Ollama", "ollama.exe")
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  async function getOllamaModels() {
    try {
      const response = await fetch(`${OLLAMA_API}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) return null;
      const data = await response.json();
      return Array.isArray(data.models)
        ? data.models.filter((model) => model && typeof model.name === "string").map((model) => model.name)
        : [];
    } catch {
      return null;
    }
  }

  function runInstaller(executable, args, label, env = process.env) {
    return new Promise((resolve, reject) => {
      sendSetupProgress(label);
      const child = spawn(executable, args, {
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let recentOutput = "";
      const recordOutput = (chunk) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          recentOutput = `${recentOutput}${recentOutput ? "\n" : ""}${line}`.slice(-6000);
          sendSetupProgress(line);
        }
      };
      child.stdout.on("data", recordOutput);
      child.stderr.on("data", recordOutput);
      child.once("error", (error) => reject(new Error(`${label}: ${error.message}`)));
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} failed${code === null ? "" : ` (exit code ${code})`}.${recentOutput ? `\n${recentOutput}` : ""}`));
      });
    });
  }

  async function ensureOllamaRunning(ollamaPath) {
    if (await getOllamaModels() !== null) return;
    sendSetupProgress("Starting Ollama locally…");
    let startupError = null;
    ollamaProcess = spawn(ollamaPath, ["serve"], {
      windowsHide: true,
      env: { ...process.env, OLLAMA_HOST },
      stdio: "ignore"
    });
    ollamaProcess.once("error", (error) => {
      startupError = error;
      sendSetupProgress(`Could not start Ollama: ${error.message}`);
    });

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const models = await getOllamaModels();
      if (models !== null) return;
      if (startupError) {
        throw new Error(`Could not start Ollama: ${startupError.message}`);
      }
      if (ollamaProcess.exitCode !== null) {
        throw new Error("Ollama stopped while starting. Open the Ollama app and try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Ollama did not start in time. Open the Ollama app and try again.");
  }

  async function installOllamaAndModel(modelName = OLLAMA_MODEL) {
    if (setupInProgress) throw new Error("Setup is already running.");
    if (typeof modelName !== "string" || ![...MODEL_CHOICES, OLLAMA_MODEL].includes(modelName)) {
      throw new Error("Choose the compact Qwen3 1.7B or powerful Qwen3 Coder model.");
    }
    setupInProgress = true;
    try {
      let ollamaPath = locateOllama();
      if (!ollamaPath) {
        sendSetupProgress("Installing Ollama with Windows Package Manager…");
        try {
          execFileSync("where.exe", ["winget"], {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"]
          });
        } catch {
          throw new Error(
            "Windows Package Manager (winget) was not found. Install Ollama from the official Windows download page, then reopen this app."
          );
        }
        await runInstaller("winget", [
          "install", "--id", "Ollama.Ollama", "--exact", "--silent",
          "--accept-package-agreements", "--accept-source-agreements"
        ], "Installing Ollama");
        ollamaPath = locateOllama();
        if (!ollamaPath) {
          throw new Error("Ollama installed but its command-line program was not found. Restart Windows and try again.");
        }
      } else {
        sendSetupProgress("Ollama is installed.");
      }

      await ensureOllamaRunning(ollamaPath);
      let models = await getOllamaModels();
      if (!models || !models.some((name) => name === modelName || name === `${modelName}:latest`)) {
        sendSetupProgress(`Downloading ${modelName}. The smaller Qwen3 1.7B model uses less storage and memory; Qwen3 Coder is the more capable, larger option…`);
        await runInstaller(
          ollamaPath,
          ["pull", modelName],
          `Downloading ${modelName}`,
          { ...process.env, OLLAMA_HOST }
        );
      } else {
        sendSetupProgress(`${modelName} is already installed.`);
      }
      sendSetupProgress("Setup complete. Refreshing the local model list…");
      return { installed: true, model: modelName };
    } finally {
      setupInProgress = false;
    }
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 760,
      minHeight: 620,
      show: false,
      backgroundColor: "#0d1117",
      title: "Local Project Assistant",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, destination) => {
      let destinationOrigin;
      try {
        destinationOrigin = new URL(destination).origin;
      } catch {
        event.preventDefault();
        return;
      }
      if (!appUrl || destinationOrigin !== new URL(appUrl).origin) event.preventDefault();
    });
    mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.on("closed", () => { mainWindow = null; });
    return mainWindow.loadURL(`${appUrl}/`);
  }

  ipcMain.handle("setup:install", async (event, modelName) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("The setup request is not from this app window.");
    return await installOllamaAndModel(modelName || OLLAMA_MODEL);
  });

  ipcMain.handle("setup:open-download", async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("The download request is not from this app window.");
    await shell.openExternal(OLLAMA_DOWNLOAD_URL);
  });

  function requireMainWindow(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error("The update request is not from this app window.");
    }
  }

  ipcMain.handle("update:check", async (event) => {
    requireMainWindow(event);
    await checkForUpdates();
  });

  ipcMain.handle("update:download", async (event) => {
    requireMainWindow(event);
    if (!app.isPackaged || !availableUpdate) throw new Error("There is no available update to download.");
    sendUpdateStatus({ state: "downloading", percent: 0, message: "Starting update download…" });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      sendUpdateStatus({ state: "error", message: `Update download failed: ${error.message}` });
      throw error;
    }
  });

  ipcMain.handle("update:install", (event) => {
    requireMainWindow(event);
    if (!app.isPackaged) throw new Error("Updates can only be installed from the packaged app.");
    autoUpdater.quitAndInstall();
  });

  const hasSingleInstance = app.requestSingleInstanceLock();
  if (!hasSingleInstance) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(async () => {
      try {
        appServer = createAppServer({
          pickFolder: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: "Choose a project folder for this chat",
              buttonLabel: "Connect folder",
              properties: ["openDirectory"]
            });
            return result.canceled ? null : result.filePaths[0] || null;
          }
        });
        appServer.on("error", async (error) => {
          await dialog.showMessageBox({
            type: "error",
            title: "Could not start Local Project Assistant",
            message: error.message
          });
          app.quit();
        });
        appServer.listen(0, "127.0.0.1", async () => {
          appUrl = `http://127.0.0.1:${appServer.address().port}`;
          try {
            await createWindow();
          } catch (error) {
            await dialog.showMessageBox({
              type: "error",
              title: "Could not open Local Project Assistant",
              message: error.message
            });
            app.quit();
          }
        });
      } catch (error) {
        await dialog.showMessageBox({
          type: "error",
          title: "Could not start Local Project Assistant",
          message: error.message
        });
        app.quit();
      }
    });
  }

  app.on("before-quit", () => {
    if (appServer && appServer.listening) appServer.close();
    if (ollamaProcess && ollamaProcess.exitCode === null) ollamaProcess.kill();
  });
  app.on("window-all-closed", () => app.quit());
}
