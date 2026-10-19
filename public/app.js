const elements = {
  appShell: document.querySelector("#app-shell"),
  authError: document.querySelector("#auth-error"),
  authForm: document.querySelector("#auth-form"),
  authPassword: document.querySelector("#auth-password"),
  authScreen: document.querySelector("#auth-screen"),
  authSubmit: document.querySelector("#auth-submit"),
  authTitle: document.querySelector("#auth-title"),
  authUsername: document.querySelector("#auth-username"),
  modelInstall: document.querySelector("#model-install"),
  setupModelSelect: document.querySelector("#setup-model-select"),
  appUpdate: document.querySelector("#app-update"),
  appUpdateButton: document.querySelector("#app-update-button"),
  appUpdateStatus: document.querySelector("#app-update-status"),
  conversationList: document.querySelector("#conversation-list"),
  chatManagementCancel: document.querySelector("#chat-management-cancel"),
  chatManagementConfirm: document.querySelector("#chat-management-confirm"),
  chatManagementDescription: document.querySelector("#chat-management-description"),
  chatManagementDialog: document.querySelector("#chat-management-dialog"),
  chatManagementError: document.querySelector("#chat-management-error"),
  chatManagementEyebrow: document.querySelector("#chat-management-eyebrow"),
  chatManagementTitle: document.querySelector("#chat-management-title"),
  chatTitleInput: document.querySelector("#chat-title-input"),
  chatTitleLabel: document.querySelector("#chat-title-label"),
  accountName: document.querySelector("#account-name"),
  activityHeading: document.querySelector("#activity-heading"),
  activityIndicator: document.querySelector("#activity-indicator"),
  activityList: document.querySelector("#activity-list"),
  activityLiveLabel: document.querySelector("#activity-live-label"),
  activityPanel: document.querySelector("#activity-panel"),
  desktopSetupDialog: document.querySelector("#desktop-setup-dialog"),
  desktopSetupDescription: document.querySelector("#desktop-setup-description"),
  desktopSetupProgress: document.querySelector("#desktop-setup-progress"),
  desktopSetupInstall: document.querySelector("#desktop-setup-install"),
  desktopOpenOllama: document.querySelector("#desktop-open-ollama"),
  loginTab: document.querySelector("#login-tab"),
  registerTab: document.querySelector("#register-tab"),
  passwordGuidance: document.querySelector("#password-guidance"),
  logoutButton: document.querySelector("#logout-button"),
  previewFrame: document.querySelector("#preview-frame"),
  previewFind: document.querySelector("#preview-find"),
  previewPath: document.querySelector("#preview-path"),
  previewPane: document.querySelector("#preview-pane"),
  previewReload: document.querySelector("#preview-reload"),
  previewStatus: document.querySelector("#preview-status"),
  previewViewButton: document.querySelector("#preview-view-button"),
  terminalApprovalDialog: document.querySelector("#terminal-approval-dialog"),
  terminalApprovedCommand: document.querySelector("#terminal-approved-command"),
  terminalApprove: document.querySelector("#terminal-approve"),
  terminalCancel: document.querySelector("#terminal-cancel"),
  terminalCommand: document.querySelector("#terminal-command"),
  terminalFolderName: document.querySelector("#terminal-folder-name"),
  terminalOutput: document.querySelector("#terminal-output"),
  terminalRun: document.querySelector("#terminal-run"),
  terminalShare: document.querySelector("#terminal-share"),
  terminalStatus: document.querySelector("#terminal-status"),
  terminalViewButton: document.querySelector("#terminal-view-button"),
  terminalPane: document.querySelector("#terminal-pane"),
  terminalPreview: document.querySelector("#terminal-preview"),
  chatForm: document.querySelector("#chat-form"),
  chatScroll: document.querySelector("#chat-scroll"),
  chatViewButton: document.querySelector("#chat-view-button"),
  connectionStatus: document.querySelector("#connection-status"),
  composerArea: document.querySelector("#composer-area"),
  connectFolder: document.querySelector("#connect-folder"),
  folderDot: document.querySelector("#folder-dot"),
  folderGuidance: document.querySelector("#folder-guidance"),
  folderName: document.querySelector("#folder-name"),
  folderStatus: document.querySelector("#folder-status"),
  headerTitle: document.querySelector("#header-title"),
  input: document.querySelector("#message-input"),
  messages: document.querySelector("#messages"),
  modelSelect: document.querySelector("#model-select"),
  newChat: document.querySelector("#new-chat"),
  refreshModels: document.querySelector("#refresh-models"),
  sendButton: document.querySelector("#send-button"),
  sidebar: document.querySelector("#sidebar"),
  sidebarBackdrop: document.querySelector("#sidebar-backdrop"),
  statusLabel: document.querySelector("#status-label"),
  topConnectFolder: document.querySelector("#top-connect-folder"),
  composerFolderLabel: document.querySelector("#composer-folder-label"),
  typing: document.querySelector("#typing-indicator"),
  welcome: document.querySelector("#welcome"),
  welcomeConnectFolder: document.querySelector("#welcome-connect-folder")
};

let history = [];
let pending = false;
let titleSet = false;
let workspaceId = null;
let folderPickerOpen = false;
let selectedModel = "qwen3-coder";
let installedModels = [];
let chatId = null;
let chatTitle = "New conversation";
let account = null;
let savedChats = [];
let authMode = "login";
let activeView = "chat";
let terminalApproval = null;
let requestingTerminalApproval = false;
let approvingTerminalCommand = false;
let desktopSetupRunning = false;
let desktopSetupTargetModel = null;
let removeSetupProgressListener = null;
let activityItems = new Map();
let chatManagementAction = null;
let chatManagementBusy = false;
let appUpdateState = "idle";

function resolveInstalledModel(name) {
  if (installedModels.includes(name)) return name;
  if (installedModels.includes(`${name}:latest`)) return `${name}:latest`;
  return null;
}

async function findPreviewPage() {
  if (!workspaceId) return;
  const candidates = ["index.html", "public/index.html", "src/index.html", "app/index.html", "dist/index.html", "build/index.html"];
  elements.previewFind.disabled = true;
  elements.previewStatus.classList.remove("error");
  elements.previewStatus.textContent = "Looking for a previewable HTML page…";
  try {
    for (const candidate of candidates) {
      const response = await fetch(createPreviewUrl(candidate));
      if (response.ok) {
        elements.previewPath.value = candidate;
        await loadPreview();
        return;
      }
      if (response.status !== 404) {
        const result = await response.json();
        throw new Error(result.error || `Could not inspect ${candidate} (${response.status}).`);
      }
    }
    throw new Error("No common HTML entry page was found. Enter its project-relative path above, or ask the assistant to create index.html.");
  } catch (error) {
    elements.previewStatus.textContent = error.message;
    elements.previewStatus.classList.add("error");
  } finally {
    elements.previewFind.disabled = !workspaceId || pending || folderPickerOpen;
  }
}

function setWorkspaceView(view) {
  activeView = view;
  const showChat = view === "chat";
  const showPreview = view === "preview";
  const showTerminal = view === "terminal";
  elements.chatScroll.classList.toggle("hidden", !showChat);
  elements.composerArea.classList.toggle("hidden", !showChat);
  elements.previewPane.classList.toggle("hidden", !showPreview);
  elements.terminalPane.classList.toggle("hidden", !showTerminal);
  elements.chatViewButton.classList.toggle("active", showChat);
  elements.previewViewButton.classList.toggle("active", showPreview);
  elements.terminalViewButton.classList.toggle("active", showTerminal);
  elements.chatViewButton.setAttribute("aria-pressed", String(showChat));
  elements.previewViewButton.setAttribute("aria-pressed", String(showPreview));
  elements.terminalViewButton.setAttribute("aria-pressed", String(showTerminal));
}

function resetActivity() {
  activityItems.clear();
  elements.activityList.replaceChildren();
  elements.activityPanel.classList.add("hidden");
  elements.activityPanel.classList.remove("running", "complete", "error");
  elements.activityHeading.textContent = "Project activity";
  elements.activityLiveLabel.textContent = "Live";
}

function updateActivity(activity) {
  if (!activity || typeof activity.message !== "string") return;
  elements.activityPanel.classList.remove("hidden", "complete", "error");
  elements.activityPanel.classList.add(activity.status === "running" ? "running" : "complete");
  if (activity.status === "error") elements.activityPanel.classList.add("error");
  elements.activityHeading.textContent = activity.status === "running"
    ? "Working in your project"
    : activity.status === "error" ? "Project action needs attention" : "Project activity";
  elements.activityLiveLabel.textContent = activity.status === "running"
    ? "Working"
    : activity.status === "error" ? "Check" : "Updated";

  let item = activityItems.get(activity.id);
  if (!item) {
    item = document.createElement("li");
    item.className = "activity-item";
    const state = document.createElement("span");
    state.className = "activity-state";
    state.setAttribute("aria-hidden", "true");
    const message = document.createElement("span");
    message.className = "activity-message";
    item.append(state, message);
    elements.activityList.append(item);
    activityItems.set(activity.id, item);
    while (activityItems.size > 60) {
      const oldestId = activityItems.keys().next().value;
      const oldestItem = activityItems.get(oldestId);
      oldestItem.remove();
      activityItems.delete(oldestId);
    }
  }

  item.classList.remove("running", "complete", "error");
  item.classList.add(activity.status === "running" ? "running" : activity.status === "error" ? "error" : "complete");
  item.querySelector(".activity-state").textContent =
    activity.status === "running" ? "…" : activity.status === "error" ? "!" : "✓";
  item.querySelector(".activity-message").textContent = activity.message;
  elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
}

function finishActivity(success) {
  elements.activityPanel.classList.remove("running", "complete", "error");
  elements.activityPanel.classList.add(success ? "complete" : "error");
  elements.activityHeading.textContent = success ? "Finished this request" : "Request needs attention";
  elements.activityLiveLabel.textContent = success ? "Done" : "Check";
}

async function readChatActivityStream(response) {
  if (!response.body) throw new Error("Live project activity is not available in this browser.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let finished = false;

  function processFrame(frame) {
    let eventName = "message";
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join("\n"));
    if (eventName === "activity") updateActivity(data);
    else if (eventName === "result") result = data;
    else if (eventName === "error") throw new Error(data.error || "The assistant request failed.");
    else if (eventName === "done") finished = true;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) processFrame(frame);
      if (done) break;
    }
    if (buffer.trim()) processFrame(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!finished || !result || typeof result.message !== "string") {
    throw new Error("The live assistant response ended before it was complete.");
  }
  return result;
}

function createPreviewUrl(relativePath) {
  if (!workspaceId) throw new Error("Choose a project folder before opening the preview.");
  const normalized = relativePath.trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment === "." || segment.includes(":")) ||
    normalized.includes("\0")
  ) {
    throw new Error("Enter a project-relative file path without '..' or an absolute path.");
  }
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `/api/preview/${encodeURIComponent(workspaceId)}/${encodedPath}`;
}

async function loadPreview() {
  if (!workspaceId) return;
  elements.previewStatus.classList.remove("error");
  elements.previewStatus.textContent = "Loading a restricted static preview…";
  elements.previewReload.disabled = true;
  try {
    const previewUrl = createPreviewUrl(elements.previewPath.value || "index.html");
    const response = await fetch(previewUrl);
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || `Preview unavailable (${response.status}).`);
    }
    elements.previewPath.value = elements.previewPath.value.trim().replace(/\\/g, "/") || "index.html";
    elements.previewFrame.src = previewUrl;
    elements.previewStatus.textContent = "Sandboxed static preview · project network access and forms are disabled";
  } catch (error) {
    elements.previewStatus.textContent = error.message;
    elements.previewStatus.classList.add("error");
  } finally {
    elements.previewReload.disabled = !workspaceId || pending || folderPickerOpen;
  }
}

async function requestTerminalApproval(command = elements.terminalCommand.value) {
  if (!workspaceId || !command.trim() || terminalApproval) return;
  requestingTerminalApproval = true;
  elements.terminalStatus.classList.remove("error");
  elements.terminalStatus.textContent = "Preparing command approval…";
  elements.terminalRun.disabled = true;
  updateSendButton();
  try {
    const response = await fetch("/api/terminal/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, command })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Approval request failed (${response.status}).`);
    terminalApproval = { id: result.approvalId, command: result.command };
    elements.terminalCommand.disabled = true;
    elements.terminalApprovedCommand.textContent = result.command;
    elements.terminalApprovalDialog.showModal();
    elements.terminalStatus.textContent = `Review the exact command before approving it in ${result.folderName}.`;
  } catch (error) {
    elements.terminalStatus.textContent = error.message;
    elements.terminalStatus.classList.add("error");
  } finally {
    requestingTerminalApproval = false;
    updateSendButton();
  }
}

async function approveTerminalCommand() {
  if (!terminalApproval || approvingTerminalCommand) return;
  approvingTerminalCommand = true;
  elements.terminalApprove.disabled = true;
  updateSendButton();
  elements.terminalStatus.classList.remove("error");
  elements.terminalStatus.textContent = "Running the approved command…";
  elements.terminalOutput.textContent = `PS> ${terminalApproval.command}\n\nRunning…`;
  try {
    const response = await fetch("/api/terminal/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: terminalApproval.id })
    });
    const result = await response.json();
    terminalApproval = null;
    elements.terminalApprovalDialog.close("approved");
    const output = result.output || "(No output.)";
    elements.terminalOutput.textContent =
      `PS> ${result.command || ""}\n\n${result.error ? `${result.error}\n\n` : ""}${output}`;
    elements.terminalShare.disabled = false;
    if (!response.ok) {
      elements.terminalStatus.textContent = result.error || "The command could not be completed.";
      elements.terminalStatus.classList.add("error");
    } else if (result.timedOut) {
      elements.terminalStatus.textContent = `Command request timed out after two minutes · exit ${result.exitCode}. Separately started programs may still be running.`;
      elements.terminalStatus.classList.add("error");
    } else if (result.exitCode === 0) {
      elements.terminalStatus.textContent = `Finished successfully in ${(result.durationMs / 1000).toFixed(1)}s.`;
    } else {
      elements.terminalStatus.textContent = `Finished with exit code ${result.exitCode}. Review the output below.`;
      elements.terminalStatus.classList.add("error");
    }
  } catch (error) {
    terminalApproval = null;
    if (elements.terminalApprovalDialog.open) elements.terminalApprovalDialog.close("failed");
    elements.terminalOutput.textContent = error.message;
    elements.terminalStatus.textContent = error.message;
    elements.terminalStatus.classList.add("error");
  } finally {
    approvingTerminalCommand = false;
    elements.terminalApprove.disabled = false;
    updateSendButton();
  }
}

function shareTerminalOutput() {
  const output = elements.terminalOutput.textContent.trim();
  if (!output || output.startsWith("Output from approved commands appears here.")) return;
  elements.input.value = `Please help me interpret this terminal output:\n\n\`\`\`text\n${output.slice(-12000)}\n\`\`\``;
  resizeInput();
  setWorkspaceView("chat");
  updateSendButton();
  elements.input.focus();
}

async function cancelTerminalApproval() {
  if (!terminalApproval || approvingTerminalCommand) return;
  const approvalId = terminalApproval.id;
  terminalApproval = null;
  elements.terminalCommand.disabled = !workspaceId || pending || folderPickerOpen;
  elements.terminalRun.disabled = !workspaceId || pending || folderPickerOpen ||
    !elements.terminalCommand.value.trim();
  try {
    await fetch("/api/terminal/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId })
    });
  } catch {
    elements.terminalStatus.textContent = "Approval was not run; its server-side request expires in two minutes.";
  }
}

function resetTerminalState() {
  terminalApproval = null;
  if (elements.terminalApprovalDialog.open) elements.terminalApprovalDialog.close("reset");
  elements.terminalCommand.value = "";
  elements.terminalOutput.textContent =
    "Output from approved commands appears here. A command request times out after two minutes; a program it started separately may continue running.";
  elements.terminalShare.disabled = true;
  elements.terminalStatus.textContent = workspaceId
    ? "Review each command before approving it."
    : "Choose a folder to enable terminal commands.";
  elements.terminalStatus.classList.remove("error");
}

function updateModelOptions(models, preferredModel) {
  const previousModel = selectedModel;
  installedModels = [...new Set(models.filter((name) => typeof name === "string" && name))].sort((a, b) => {
    const aCoder = /coder|code|devstral/i.test(a) ? 0 : 1;
    const bCoder = /coder|code|devstral/i.test(b) ? 0 : 1;
    return aCoder - bCoder || a.localeCompare(b);
  });
  const configuredModel = preferredModel || "qwen3-coder";
  const modelOptions = new Map([
    ["qwen3-coder", { label: "Qwen3 Coder · powerful" }],
    ["qwen3:1.7b", { label: "Qwen3 1.7B · smaller" }]
  ]);
  if (!modelOptions.has(configuredModel)) modelOptions.set(configuredModel, { label: configuredModel });
  for (const name of installedModels) {
    if (!modelOptions.has(name)) modelOptions.set(name, { label: name });
  }
  const options = [...modelOptions].map(([name, option]) => ({
    value: name,
    label: resolveInstalledModel(name) ? option.label : `${option.label} · install`
  }));

  elements.modelSelect.replaceChildren();
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    elements.modelSelect.append(node);
  }

  selectedModel = resolveInstalledModel(previousModel) ||
    resolveInstalledModel(configuredModel) ||
    installedModels.find((name) => /^qwen3:1\.7b(?::latest)?$/i.test(name)) ||
    ([...modelOptions.keys()].includes(previousModel) ? previousModel : configuredModel);
  elements.modelSelect.value = selectedModel;
  elements.modelSelect.title = installedModels.length
    ? "Choose a model already installed in local Ollama, or select Install to download one."
    : "Choose either model, then use Install to download it.";
  elements.modelInstall.classList.toggle("hidden", !window.desktopApi?.isDesktop || Boolean(resolveInstalledModel(selectedModel)));
  elements.modelInstall.disabled = !window.desktopApi?.isDesktop;
}

function setStatus(status, model, error, models = []) {
  updateModelOptions(models, model);
  const selectedAvailable = installedModels.includes(selectedModel);
  elements.connectionStatus.classList.remove("connected", "disconnected");
  if (status === "connected" && selectedAvailable) {
    elements.connectionStatus.classList.add("connected");
    elements.statusLabel.textContent = "Ollama ready";
    elements.connectionStatus.title = `${selectedModel} is available locally`;
  } else if (status === "unavailable") {
    elements.connectionStatus.classList.add("disconnected");
    elements.statusLabel.textContent = "Ollama offline";
    elements.connectionStatus.title = error || "Start Ollama to chat";
  } else if (status === "model-missing" || (status === "connected" && !selectedAvailable)) {
    elements.connectionStatus.classList.add("disconnected");
    elements.statusLabel.textContent = "Model not found";
    elements.connectionStatus.title = `Pull ${selectedModel} in Ollama or choose an installed model.`;
  } else {
    elements.statusLabel.textContent = "Checking Ollama";
    elements.connectionStatus.title = "";
  }
}

function updateDesktopSetup(status) {
  if (!window.desktopApi?.isDesktop || !account) return;
  const model = desktopSetupTargetModel || selectedModel || status.model || "qwen3-coder";
  const modelAvailable = installedModels.includes(model) || installedModels.includes(`${model}:latest`);
  const ready = status.ollama === "connected" && modelAvailable;
  if (ready) {
    if (elements.desktopSetupDialog.open && !desktopSetupRunning) {
      elements.desktopSetupDialog.close("ready");
    }
    desktopSetupTargetModel = null;
    return;
  }

  if (!elements.desktopSetupDialog.open) desktopSetupTargetModel = model;
  if ([...elements.setupModelSelect.options].some((option) => option.value === model)) {
    elements.setupModelSelect.value = model;
  }
  elements.desktopSetupDescription.textContent =
    "Choose the powerful coding model or its smaller 1.7B version, which needs less memory and storage. Only the selected model will be downloaded.";
  elements.desktopSetupProgress.textContent = status.ollama === "connected"
    ? `Ollama is ready, but ${model} is not installed. Choose a model to install.`
    : "Ollama is not running. Install it and the coding model to start chatting.";
  if (!elements.desktopSetupDialog.open && !desktopSetupRunning) {
    elements.desktopSetupDialog.showModal();
  }
}

async function installDesktopRequirements() {
  if (!window.desktopApi?.isDesktop || desktopSetupRunning) return;
  const modelToInstall = elements.setupModelSelect.value;
  desktopSetupTargetModel = modelToInstall;
  desktopSetupRunning = true;
  elements.desktopSetupInstall.disabled = true;
  elements.desktopOpenOllama.classList.add("hidden");
  elements.desktopSetupProgress.classList.remove("error");
  elements.desktopSetupProgress.textContent = "Starting setup…";
  try {
    await window.desktopApi.installOllamaAndModel(modelToInstall);
    await checkStatus();
    if (resolveInstalledModel(modelToInstall)) {
      selectedModel = resolveInstalledModel(modelToInstall);
      elements.modelSelect.value = selectedModel;
      elements.modelInstall.classList.add("hidden");
      await checkStatus();
    }
    if (elements.desktopSetupDialog.open && resolveInstalledModel(modelToInstall)) {
      elements.desktopSetupDialog.close("ready");
      desktopSetupTargetModel = null;
    } else {
      elements.desktopSetupProgress.textContent = `Setup finished, but ${modelToInstall} is not available yet. Check Ollama and retry.`;
      elements.desktopSetupProgress.classList.add("error");
    }
  } catch (error) {
    elements.desktopSetupProgress.textContent = error.message;
    elements.desktopSetupProgress.classList.add("error");
    if (/winget was not found/i.test(error.message)) {
      elements.desktopOpenOllama.classList.remove("hidden");
    }
  } finally {
    desktopSetupRunning = false;
    elements.desktopSetupInstall.disabled = false;
  }
}

async function checkAuthentication() {
    try {
      const response = await fetch("/api/auth/me");
      const result = await response.json();
      if (response.ok && result.authenticated && result.user) {
        await activateApp(result.user);
        return;
      }
    } catch {
      elements.authError.textContent = "The local assistant server is unavailable.";
      elements.authError.classList.remove("hidden");
    }
    showAuthentication();
  }

function showAuthentication() {
    account = null;
    workspaceId = null;
    resetActivity();
    resetTerminalState();
    chatId = null;
    history = [];
    savedChats = [];
    elements.previewFrame.removeAttribute("src");
    setWorkspaceView("chat");
    updateFolderDetails(null);
    discardChat();
    renderSavedChats();
    elements.appShell.classList.add("hidden");
    elements.authScreen.classList.remove("hidden");
    elements.authUsername.focus();
  }

async function activateApp(user) {
    account = user;
    elements.accountName.textContent = user.username;
    elements.authScreen.classList.add("hidden");
    elements.appShell.classList.remove("hidden");
    if (window.desktopApi?.isDesktop && !removeSetupProgressListener) {
      removeSetupProgressListener = window.desktopApi.onSetupProgress((message) => {
        elements.desktopSetupProgress.textContent = message;
        elements.desktopSetupProgress.classList.remove("error");
      });
    }
    await checkStatus();
    try {
      await loadSavedChats();
    } catch (error) {
      elements.folderGuidance.textContent = error.message;
      elements.folderGuidance.classList.add("error");
    }
  }

function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === "register";
    elements.loginTab.classList.toggle("active", !registering);
    elements.registerTab.classList.toggle("active", registering);
    elements.loginTab.setAttribute("aria-selected", String(!registering));
    elements.registerTab.setAttribute("aria-selected", String(registering));
    elements.authTitle.textContent = registering ? "Create your account" : "Welcome back";
    elements.authSubmit.textContent = registering ? "Create account" : "Sign in";
    elements.authPassword.autocomplete = registering ? "new-password" : "current-password";
    elements.authPassword.minLength = registering ? 10 : 1;
    elements.passwordGuidance.classList.toggle("hidden", !registering);
    elements.authError.classList.add("hidden");
  }

async function loadSavedChats() {
    const response = await fetch("/api/chats");
    const result = await response.json();
    if (response.status === 401) {
      showAuthentication();
      return;
    }
    if (!response.ok || !Array.isArray(result.chats)) {
      throw new Error(result.error || "Could not load saved chats.");
    }
    savedChats = result.chats;
    renderSavedChats();
  }

function renderSavedChats() {
    elements.conversationList.replaceChildren();
    if (!savedChats.length) {
      const empty = document.createElement("p");
      empty.className = "conversation-empty";
      empty.textContent = "Your saved chats will appear here.";
      elements.conversationList.append(empty);
      return;
    }
    for (const chat of savedChats) {
      const row = document.createElement("div");
      row.className = "conversation-entry";
      const button = document.createElement("button");
      button.className = `conversation-item${chat.id === chatId ? " active" : ""}`;
      button.type = "button";
      button.title = chat.title;
      button.disabled = chatManagementBusy;
      button.addEventListener("click", () => openSavedChat(chat.id));
      const icon = document.createElement("span");
      icon.className = "conversation-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "◷";
      const title = document.createElement("span");
      title.className = "conversation-name";
      title.textContent = chat.title;
      button.append(icon, title);
      const rename = document.createElement("button");
      rename.className = "conversation-action";
      rename.type = "button";
      rename.title = `Rename ${chat.title}`;
      rename.setAttribute("aria-label", `Rename chat: ${chat.title}`);
      rename.textContent = "✎";
      rename.disabled = chatManagementBusy;
      rename.addEventListener("click", () => openChatManagement("rename", chat));
      const remove = document.createElement("button");
      remove.className = "conversation-action delete";
      remove.type = "button";
      remove.title = `Delete ${chat.title}`;
      remove.setAttribute("aria-label", `Delete chat: ${chat.title}`);
      remove.textContent = "×";
      remove.disabled = chatManagementBusy;
      remove.addEventListener("click", () => openChatManagement("delete", chat));
      row.append(button, rename, remove);
      elements.conversationList.append(row);
    }
  }

function openChatManagement(action, chat) {
    chatManagementAction = { action, chatId: chat.id, previousTitle: chat.title };
    elements.chatManagementError.textContent = "";
    elements.chatManagementError.classList.add("hidden");
    const isRename = action === "rename";
    elements.chatManagementEyebrow.textContent = isRename ? "RENAME SAVED CHAT" : "DELETE SAVED CHAT";
    elements.chatManagementTitle.textContent = isRename ? "Rename chat" : "Delete this chat?";
    elements.chatManagementDescription.textContent = isRename
      ? "Choose a clear name for this conversation. Its messages will stay unchanged."
      : `“${chat.title}” and its saved messages will be permanently deleted from this PC.`;
    elements.chatTitleInput.classList.toggle("hidden", !isRename);
    elements.chatTitleLabel.classList.toggle("hidden", !isRename);
    elements.chatTitleInput.value = chat.title;
    elements.chatManagementConfirm.textContent = isRename ? "Save name" : "Delete chat";
    elements.chatManagementConfirm.classList.toggle("delete", !isRename);
    elements.chatManagementDialog.showModal();
    if (isRename) {
      elements.chatTitleInput.focus();
      elements.chatTitleInput.select();
    } else {
      elements.chatManagementCancel.focus();
    }
  }

async function submitChatManagement() {
    if (!chatManagementAction || chatManagementBusy) return;
    const { action, chatId: targetChatId } = chatManagementAction;
    const title = elements.chatTitleInput.value.trim();
    if (action === "rename" && (!title || title.length > 120)) {
      elements.chatManagementError.textContent = "Enter a chat name between 1 and 120 characters.";
      elements.chatManagementError.classList.remove("hidden");
      elements.chatTitleInput.focus();
      return;
    }

    chatManagementBusy = true;
    elements.chatManagementConfirm.disabled = true;
    elements.chatManagementCancel.disabled = true;
    elements.chatManagementError.textContent = "";
    elements.chatManagementError.classList.add("hidden");
    let workspaceToRevoke = null;
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(targetChatId)}`, {
        method: action === "rename" ? "PATCH" : "DELETE",
        headers: action === "rename" ? { "content-type": "application/json" } : {},
        ...(action === "rename" ? { body: JSON.stringify({ title }) } : {})
      });
      const result = await response.json();
      if (response.status === 401) {
        elements.chatManagementDialog.close("expired");
        showAuthentication();
        return;
      }
      if (!response.ok) throw new Error(result.error || `Could not ${action} this chat.`);

      if (action === "rename") {
        const savedChat = savedChats.find((chat) => chat.id === result.id);
        if (savedChat) {
          savedChat.title = result.title;
          savedChat.updatedAt = result.updatedAt;
        }
        if (chatId === result.id) {
          chatTitle = result.title;
          elements.headerTitle.textContent = result.title.length > 30 ? `${result.title.slice(0, 29)}…` : result.title;
          elements.headerTitle.title = result.title;
        }
      } else {
        savedChats = savedChats.filter((chat) => chat.id !== targetChatId);
        if (chatId === targetChatId) {
          workspaceToRevoke = workspaceId;
          workspaceId = null;
          resetActivity();
          resetTerminalState();
          chatId = null;
          chatTitle = "New conversation";
          titleSet = false;
          history = [];
          elements.messages.replaceChildren();
          elements.input.value = "";
          resizeInput();
          elements.welcome.classList.remove("hidden");
          elements.headerTitle.textContent = chatTitle;
          elements.headerTitle.removeAttribute("title");
          elements.previewFrame.removeAttribute("src");
          setWorkspaceView("chat");
          updateFolderDetails(null);
          updateSendButton();
        }
      }
      chatManagementBusy = false;
      elements.chatManagementConfirm.disabled = false;
      elements.chatManagementCancel.disabled = false;
      renderSavedChats();
      elements.chatManagementDialog.close("saved");
      if (workspaceToRevoke) {
        try {
          const revokeResponse = await fetch("/api/folders/revoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: workspaceToRevoke })
          });
          if (!revokeResponse.ok) {
            const revokeResult = await revokeResponse.json();
            elements.folderGuidance.textContent = `Chat deleted. Folder disconnect failed: ${revokeResult.error || revokeResponse.statusText}`;
            elements.folderGuidance.classList.add("error");
          }
        } catch (error) {
          elements.folderGuidance.textContent = `Chat deleted. Folder disconnect failed: ${error.message}`;
          elements.folderGuidance.classList.add("error");
        }
      }
    } catch (error) {
      elements.chatManagementError.textContent = error.message;
      elements.chatManagementError.classList.remove("hidden");
    } finally {
      chatManagementBusy = false;
      elements.chatManagementConfirm.disabled = false;
      elements.chatManagementCancel.disabled = false;
    }
  }

function upsertSavedChat(chat) {
    savedChats = [chat, ...savedChats.filter((entry) => entry.id !== chat.id)]
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    renderSavedChats();
  }

async function openSavedChat(id) {
    if (pending || folderPickerOpen || requestingTerminalApproval || approvingTerminalCommand || id === chatId) {
      closeSidebar();
      return;
    }
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(id)}`);
      const result = await response.json();
      if (response.status === 401) {
        showAuthentication();
        return;
      }
      if (!response.ok) throw new Error(result.error || "Could not open this saved chat.");
      if (workspaceId) {
        const revokeResponse = await fetch("/api/folders/revoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId })
        });
        if (!revokeResponse.ok) throw new Error("Could not safely disconnect the previous folder.");
      }
      workspaceId = null;
      resetActivity();
      resetTerminalState();
      chatId = result.id;
      chatTitle = result.title;
      elements.previewFrame.removeAttribute("src");
      setWorkspaceView("chat");
      history = result.messages;
      titleSet = true;
      elements.messages.replaceChildren();
      elements.input.value = "";
      resizeInput();
      for (const message of history) addMessage(message.role, message.content);
      elements.welcome.classList.toggle("hidden", history.length > 0);
      const visibleTitle = result.title.length > 30 ? `${result.title.slice(0, 29)}…` : result.title;
      elements.headerTitle.textContent = visibleTitle;
      elements.headerTitle.title = result.title;
      updateFolderDetails(null);
      elements.folderGuidance.textContent = "Choose a folder again to resume file access for this saved chat.";
      if (typeof result.model === "string" && installedModels.includes(result.model)) {
        selectedModel = result.model;
        elements.modelSelect.value = selectedModel;
      }
      updateSendButton();
      renderSavedChats();
      closeSidebar();
    } catch (error) {
      elements.folderGuidance.textContent = error.message;
      elements.folderGuidance.classList.add("error");
    }
  }

async function persistCurrentChat() {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: chatId,
        title: chatTitle,
        model: selectedModel,
        messages: history.slice(-40)
      })
    });
    const result = await response.json();
    if (response.status === 401) {
      showAuthentication();
      throw new Error("Your sign-in expired. Sign in again to save this chat.");
    }
    if (!response.ok) throw new Error(result.error || "Could not save this chat.");
    chatId = result.id;
    upsertSavedChat({
      id: result.id,
      title: result.title,
      updatedAt: result.updatedAt,
      messageCount: Math.min(history.length, 40)
    });
}

async function checkStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    if (!response.ok || status.ollama !== "connected") {
      setStatus("unavailable", status.model, status.error, status.models || []);
    } else {
      setStatus("connected", status.model, null, status.models || []);
    }
    updateDesktopSetup(status);
  } catch {
    setStatus("unavailable", "qwen3-coder", "The local assistant server is unavailable.", installedModels);
    updateDesktopSetup({ ollama: "unavailable", model: "qwen3-coder", modelAvailable: false });
  }
}

function updateSendButton() {
  const locked = pending || folderPickerOpen || requestingTerminalApproval || approvingTerminalCommand;
  elements.input.disabled = locked || !workspaceId;
  elements.sendButton.disabled = locked || !workspaceId || !elements.input.value.trim();
  elements.newChat.disabled = locked;
  elements.connectFolder.disabled = locked;
  elements.topConnectFolder.disabled = locked;
  elements.welcomeConnectFolder.disabled = locked;
  elements.logoutButton.disabled = locked;
  elements.modelInstall.disabled = locked;
  elements.previewViewButton.disabled = !workspaceId || locked;
  elements.terminalViewButton.disabled = !workspaceId || locked;
  elements.terminalPreview.disabled = !workspaceId || locked;
  elements.previewReload.disabled = !workspaceId || locked;
  elements.previewFind.disabled = !workspaceId || locked;
  elements.terminalCommand.disabled = !workspaceId || locked || Boolean(terminalApproval);
  elements.terminalRun.disabled = !workspaceId || locked ||
    Boolean(terminalApproval) || !elements.terminalCommand.value.trim();
  document.querySelectorAll("[data-terminal-command]").forEach((button) => {
    button.disabled = !workspaceId || locked || Boolean(terminalApproval);
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.disabled = pending || folderPickerOpen || !workspaceId;
  });
  elements.connectFolder.querySelector("span:last-child").textContent = folderPickerOpen
    ? "Opening folder picker…"
    : workspaceId ? "Change folder" : "Choose folder";
  elements.topConnectFolder.textContent = folderPickerOpen
    ? "Opening picker…"
    : workspaceId ? "Change folder" : "Choose folder";
  const folderIcon = document.createElement("span");
  folderIcon.setAttribute("aria-hidden", "true");
  folderIcon.textContent = "⌕";
  const folderLabel = document.createTextNode(
    folderPickerOpen ? "Opening folder picker…" : workspaceId ? "Change selected folder" : "Choose a folder to get started"
  );
  elements.welcomeConnectFolder.replaceChildren(
    folderIcon,
    folderLabel
  );
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 180)}px`;
}

function scrollToBottom() {
  elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
}

function addMessage(role, content) {
  const row = document.createElement("article");
  row.className = `message-row ${role === "user" ? "user-row" : "assistant-row"}`;

  const avatar = document.createElement("div");
  avatar.className = `avatar ${role === "user" ? "user-avatar" : "assistant-avatar"}`;
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "user" ? "You" : "✳";

  const body = document.createElement("div");
  body.className = "message-content";
  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? "You" : "Assistant";
  const text = document.createElement("div");
  text.className = "message-text";
  if (role === "assistant") appendAssistantContent(text, content);
  else text.textContent = content;
  body.append(label, text);

  if (role === "user") row.append(body, avatar);
  else row.append(avatar, body);
  elements.messages.append(row);
  scrollToBottom();
}

function appendAssistantContent(container, content) {
  const codeBlockPattern = /```([^\n`]*)\r?\n([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match;
  while ((match = codeBlockPattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = document.createElement("span");
      text.className = "assistant-copy";
      text.textContent = content.slice(lastIndex, match.index);
      container.append(text);
    }

    const language = match[1].trim();
    const code = match[2].replace(/\r?\n$/, "");
    const block = document.createElement("section");
    block.className = "code-block";
    const header = document.createElement("div");
    header.className = "code-block-header";
    const label = document.createElement("span");
    label.textContent = language || "CODE";
    const copyButton = document.createElement("button");
    copyButton.className = "copy-code-button";
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code);
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Select code to copy";
      }
      window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1600);
    });
    header.append(label);
    if (/^(powershell|pwsh|ps1)$/i.test(language)) {
      const runButton = document.createElement("button");
      runButton.className = "copy-code-button";
      runButton.type = "button";
      runButton.textContent = "Review & run";
      runButton.addEventListener("click", () => {
        elements.terminalCommand.value = code;
        setWorkspaceView("terminal");
        updateSendButton();
        requestTerminalApproval(code);
      });
      header.append(runButton);
    }
    header.append(copyButton);
    const pre = document.createElement("pre");
    const codeElement = document.createElement("code");
    codeElement.textContent = code;
    pre.append(codeElement);
    block.append(header, pre);
    container.append(block);
    lastIndex = codeBlockPattern.lastIndex;
  }

  if (lastIndex < content.length || lastIndex === 0) {
    const text = document.createElement("span");
    text.className = "assistant-copy";
    text.textContent = content.slice(lastIndex);
    container.append(text);
  }
}

function updateConversationTitle(value) {
  if (titleSet) return;
  titleSet = true;
  chatTitle = value.replace(/\s+/g, " ").trim().slice(0, 120) || "New conversation";
  const shortTitle = chatTitle.length > 30 ? `${chatTitle.slice(0, 29)}…` : chatTitle;
  elements.headerTitle.textContent = shortTitle;
  elements.headerTitle.title = chatTitle;
}

async function sendMessage(text) {
  const content = text.trim();
  if (!content || pending || !workspaceId) return;

  history.push({ role: "user", content });
  addMessage("user", content);
  elements.welcome.classList.add("hidden");
  updateConversationTitle(content);
  elements.input.value = "";
  resizeInput();
  resetActivity();
  pending = true;
  elements.typing.classList.remove("hidden");
  updateSendButton();
  scrollToBottom();

  try {
    await persistCurrentChat();
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ workspaceId, model: selectedModel, messages: history.slice(-40) })
    });
    if (!response.ok) {
      const result = await response.json();
      const error = new Error(result.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    const result = response.headers.get("content-type")?.includes("text/event-stream")
      ? await readChatActivityStream(response)
      : await response.json();
    if (typeof result.message !== "string") throw new Error("The assistant returned an invalid response.");
    history.push({ role: "assistant", content: result.message });
    addMessage("assistant", result.message);
    await persistCurrentChat();
  } catch (error) {
    updateActivity({
      id: `error-${Date.now()}`,
      message: `Request failed · ${error.message}`,
      status: "error"
    });
    addMessage("assistant", `I couldn't complete that request. ${error.message}`);
    if (error.status === 410) {
      workspaceId = null;
      updateFolderDetails(null);
      updateSendButton();
    }
  } finally {
    pending = false;
    elements.typing.classList.add("hidden");
    if (!elements.activityPanel.classList.contains("hidden")) finishActivity(!elements.activityPanel.querySelector(".activity-item.error"));
    updateSendButton();
    elements.input.focus();
  }
}

function updateFolderDetails(name) {
  elements.folderName.textContent = name || "No folder connected";
  elements.folderStatus.textContent = name ? "Connected for this chat" : "Choose a folder to begin";
  elements.folderDot.classList.toggle("hidden", !name);
  elements.composerFolderLabel.textContent = name || "Folder context";
  elements.folderGuidance.textContent = name
    ? `Connected to “${name}”. Start a new chat to choose a different folder.`
    : "The assistant only sees the folder you choose. Start a new chat to connect another one.";
  elements.folderGuidance.classList.remove("error");
  elements.terminalFolderName.textContent = name || "none selected";
}

async function chooseFolder(options = {}) {
  if (pending || folderPickerOpen || requestingTerminalApproval || approvingTerminalCommand) return;
  const startFreshChat = Boolean(options.newChat || workspaceId);
  const keepSavedChat = !startFreshChat && Boolean(chatId);
  folderPickerOpen = true;
  elements.folderGuidance.textContent = "Choose an existing folder in the window that opens.";
  elements.folderGuidance.classList.remove("error");
  updateSendButton();

  try {
    const response = await fetch("/api/folders/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previousWorkspaceId: workspaceId })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Folder selection failed (${response.status}).`);
    if (result.cancelled) {
      elements.folderGuidance.textContent = workspaceId
        ? `Still connected to “${elements.folderName.textContent}”.`
        : "Choose a folder to begin.";
      return;
    }
    if (typeof result.workspaceId !== "string" || typeof result.name !== "string") {
      throw new Error("The folder picker returned an invalid selection.");
    }

    workspaceId = result.workspaceId;
    resetActivity();
    resetTerminalState();
    if (!keepSavedChat) {
      history = [];
      chatId = null;
      chatTitle = "New conversation";
      titleSet = false;
      setWorkspaceView("chat");
      elements.messages.replaceChildren();
      elements.welcome.classList.remove("hidden");
      elements.headerTitle.textContent = chatTitle;
      elements.headerTitle.removeAttribute("title");
      elements.input.value = "";
      resizeInput();
      elements.chatScroll.scrollTop = 0;
    }
    updateFolderDetails(result.name);
    renderSavedChats();
    closeSidebar();
  } catch (error) {
    elements.folderGuidance.textContent = error.message;
    elements.folderGuidance.classList.add("error");
  } finally {
    folderPickerOpen = false;
    updateSendButton();
  }
}

function startNewChat() {
  if (pending || requestingTerminalApproval || approvingTerminalCommand) return;
  if (workspaceId) {
    elements.folderGuidance.textContent = "Choose a different existing folder for the new chat.";
    elements.folderGuidance.classList.remove("error");
  }
  chooseFolder({ newChat: true });
}

function discardChat() {
  history = [];
  chatId = null;
  chatTitle = "New conversation";
  titleSet = false;
  elements.messages.replaceChildren();
  elements.welcome.classList.remove("hidden");
  elements.headerTitle.textContent = "New conversation";
  elements.headerTitle.removeAttribute("title");
  elements.input.value = "";
  resizeInput();
  updateSendButton();
  if (workspaceId) elements.input.focus();
  closeSidebar();
}

function openSidebar() {
  elements.sidebar.classList.add("open");
  elements.sidebarBackdrop.classList.add("visible");
}

function closeSidebar() {
  elements.sidebar.classList.remove("open");
  elements.sidebarBackdrop.classList.remove("visible");
}

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(elements.input.value);
});

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.authSubmit.disabled = true;
  elements.authError.classList.add("hidden");
  try {
    const response = await fetch(`/api/auth/${authMode === "register" ? "register" : "login"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: elements.authUsername.value,
        password: elements.authPassword.value
      })
    });
    const result = await response.json();
    if (!response.ok || !result.authenticated || !result.user) {
      throw new Error(result.error || "Could not sign in.");
    }
    elements.authPassword.value = "";
    await activateApp(result.user);
  } catch (error) {
    elements.authError.textContent = error.message;
    elements.authError.classList.remove("hidden");
  } finally {
    elements.authSubmit.disabled = false;
  }
});

elements.loginTab.addEventListener("click", () => setAuthMode("login"));
elements.registerTab.addEventListener("click", () => setAuthMode("register"));
elements.chatViewButton.addEventListener("click", () => setWorkspaceView("chat"));
elements.chatManagementConfirm.addEventListener("click", submitChatManagement);
elements.chatTitleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitChatManagement();
  }
});
elements.chatManagementDialog.addEventListener("close", () => {
  chatManagementAction = null;
});
elements.previewViewButton.addEventListener("click", async () => {
  if (!workspaceId) return;
  setWorkspaceView("preview");
  await loadPreview();
});
elements.previewReload.addEventListener("click", loadPreview);
elements.previewFind.addEventListener("click", findPreviewPage);
elements.terminalPreview.addEventListener("click", async () => {
  if (!workspaceId) return;
  setWorkspaceView("preview");
  await findPreviewPage();
});
elements.previewPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadPreview();
  }
});
elements.terminalViewButton.addEventListener("click", () => setWorkspaceView("terminal"));
document.querySelectorAll("[data-terminal-command]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.terminalCommand.value = button.dataset.terminalCommand;
    elements.terminalCommand.focus();
    elements.terminalRun.disabled = !workspaceId || pending || folderPickerOpen || Boolean(terminalApproval);
    elements.terminalStatus.classList.remove("error");
    elements.terminalStatus.textContent = "Review the filled command, then choose Review command to request approval.";
  });
});
elements.terminalRun.addEventListener("click", () => requestTerminalApproval());
elements.terminalApprove.addEventListener("click", approveTerminalCommand);
elements.terminalShare.addEventListener("click", shareTerminalOutput);
elements.terminalApprovalDialog.addEventListener("close", () => {
  if (elements.terminalApprovalDialog.returnValue !== "approved") cancelTerminalApproval();
});
elements.desktopSetupInstall.addEventListener("click", installDesktopRequirements);
elements.desktopSetupDialog.addEventListener("close", () => {
  if (!desktopSetupRunning && elements.desktopSetupDialog.returnValue !== "ready") {
    desktopSetupTargetModel = null;
  }
});
elements.desktopOpenOllama.addEventListener("click", async () => {
  try {
    await window.desktopApi?.openOllamaDownload();
  } catch (error) {
    elements.desktopSetupProgress.textContent = error.message;
    elements.desktopSetupProgress.classList.add("error");
  }
});
elements.terminalCommand.addEventListener("input", () => {
  elements.terminalRun.disabled = !workspaceId || pending || folderPickerOpen ||
    !elements.terminalCommand.value.trim() || Boolean(terminalApproval);
});
elements.logoutButton.addEventListener("click", async () => {
  elements.logoutButton.disabled = true;
  try {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Could not sign out.");
    workspaceId = null;
    resetActivity();
    chatId = null;
    chatTitle = "New conversation";
    history = [];
    savedChats = [];
    elements.messages.replaceChildren();
    updateFolderDetails(null);
    elements.previewFrame.removeAttribute("src");
    setWorkspaceView("chat");
    discardChat();
    renderSavedChats();
    showAuthentication();
  } catch (error) {
    elements.folderGuidance.textContent = error.message;
    elements.folderGuidance.classList.add("error");
  } finally {
    elements.logoutButton.disabled = false;
  }
});

elements.input.addEventListener("input", () => {
  resizeInput();
  updateSendButton();
});

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!pending) sendMessage(elements.input.value);
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt));
});

elements.newChat.addEventListener("click", startNewChat);
elements.modelSelect.addEventListener("change", () => {
  selectedModel = elements.modelSelect.value;
  const installedModel = resolveInstalledModel(selectedModel);
  elements.modelInstall.classList.toggle("hidden", Boolean(installedModel) || !window.desktopApi?.isDesktop);
  if (installedModel) {
    selectedModel = installedModel;
    elements.modelSelect.value = installedModel;
    checkStatus();
  } else {
    elements.statusLabel.textContent = "Model not installed";
    elements.connectionStatus.classList.remove("connected");
    elements.connectionStatus.classList.add("disconnected");
    elements.connectionStatus.title = `Install ${selectedModel} to use it.`;
  }
});
elements.modelInstall.addEventListener("click", () => {
  elements.setupModelSelect.value = selectedModel;
  elements.desktopSetupDescription.textContent =
    `Install ${selectedModel}. Choose either the powerful Qwen3 Coder model or the smaller Qwen3 1.7B model, which uses less memory and storage.`;
  elements.desktopSetupProgress.classList.remove("error");
  elements.desktopSetupProgress.textContent = "The selected model will be downloaded from Ollama.";
  if (!elements.desktopSetupDialog.open) elements.desktopSetupDialog.showModal();
});
elements.refreshModels.addEventListener("click", async () => {
  elements.refreshModels.disabled = true;
  try {
    await checkStatus();
  } finally {
    elements.refreshModels.disabled = false;
  }
});
elements.connectFolder.addEventListener("click", chooseFolder);
elements.topConnectFolder.addEventListener("click", chooseFolder);
elements.welcomeConnectFolder.addEventListener("click", chooseFolder);
document.querySelector("#menu-button").addEventListener("click", openSidebar);
document.querySelector("#sidebar-close").addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
elements.appUpdateButton.addEventListener("click", async () => {
  if (!window.desktopApi?.isDesktop) return;
  elements.appUpdateButton.disabled = true;
  try {
    if (appUpdateState === "available") {
      await window.desktopApi.downloadUpdate();
    } else if (appUpdateState === "downloaded") {
      await window.desktopApi.installUpdate();
    } else {
      await window.desktopApi.checkForUpdates();
    }
  } catch (error) {
    elements.appUpdateStatus.textContent = error.message;
    elements.appUpdateStatus.classList.add("error");
    elements.appUpdateButton.textContent = "Retry update";
    elements.appUpdateButton.disabled = false;
  }
});

function showUpdateStatus(status) {
  if (!status || typeof status.message !== "string") return;
  appUpdateState = status.state;
  elements.appUpdateStatus.textContent = status.message;
  elements.appUpdateStatus.classList.toggle("error", status.state === "error");
  elements.appUpdateStatus.classList.toggle("available", status.state === "available" || status.state === "downloaded");
  elements.appUpdateButton.classList.toggle("available", status.state === "available" || status.state === "downloaded");
  elements.appUpdateButton.disabled = status.state === "checking" || status.state === "downloading";
  if (status.state === "available") {
    elements.appUpdateButton.textContent = `Download v${status.version}`;
  } else if (status.state === "downloading") {
    elements.appUpdateButton.textContent = `Downloading ${status.percent ?? 0}%`;
  } else if (status.state === "downloaded") {
    elements.appUpdateButton.textContent = "Restart to update";
  } else if (status.state === "checking") {
    elements.appUpdateButton.textContent = "Checking…";
  } else if (status.state === "not-available") {
    elements.appUpdateButton.textContent = "Check again";
  } else {
    elements.appUpdateButton.textContent = "Check for updates";
  }
}

if (window.desktopApi?.isDesktop) {
  window.desktopApi.onUpdateStatus(showUpdateStatus);
  window.desktopApi.checkForUpdates().catch((error) => {
    showUpdateStatus({ state: "error", message: `Update check failed: ${error.message}` });
  });
} else {
  elements.appUpdate.classList.add("hidden");
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
  if (event.key === "Escape") closeSidebar();
});

updateFolderDetails(null);
discardChat();
setAuthMode("login");
checkAuthentication();
