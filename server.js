const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const os = require("node:os");

const PROJECT_ROOT = __dirname;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_PREVIEW_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TERMINAL_COMMAND_LENGTH = 8192;
const MAX_TERMINAL_OUTPUT_BYTES = 256 * 1024;
const TERMINAL_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_SEARCHED_FILES = 2000;
const MAX_SEARCHED_DIRECTORIES = 500;
const MAX_SEARCH_RESULTS = 30;
const MAX_ACTIVE_WORKSPACES = 16;
const WORKSPACE_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_COOKIE = "local_project_assistant_session";
const PASSWORD_MIN_LENGTH = 10;
const MAX_STORED_CHATS_PER_USER = 200;
const PASSWORD_HASH_BYTES = 64;
const MAX_STORED_CHAT_BYTES = 256 * 1024;
const MODEL_CACHE_TTL_MS = 15000;
const DEFAULT_CONTEXT_LENGTH = 8192;
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS_PER_ROUND = 6;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};
const MODEL_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_project_files",
      description: "List files and folders directly inside this chat's selected folder. Use '.' for its root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative folder path, or '.' for the project root" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_project_files",
      description: "Search text inside files in this chat's selected folder to locate code, symbols, settings, or error messages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text or symbol to search for" },
          path: { type: "string", description: "Optional project-relative folder path to search; defaults to '.'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_project_file",
      description: "Read a UTF-8 text file inside this chat's selected folder.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_project_file",
      description: "Create or replace a UTF-8 text file inside this chat's selected folder. Missing parent folders are created safely.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path" },
          content: { type: "string", description: "Complete new file contents" }
        },
        required: ["path", "content"]
      }
    }
  }
];
const PREVIEW_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

function getOllamaUrl(value = process.env.OLLAMA_URL || "http://127.0.0.1:11434") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OLLAMA_URL must be a valid local HTTP URL.");
  }

  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    parsed.protocol !== "http:" ||
    !localHosts.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("OLLAMA_URL must use HTTP and point to localhost (127.0.0.1, localhost, or ::1).");
  }

  return parsed.toString().replace(/\/+$/, "");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveProjectFile(projectRoot, userPath, allowMissingFinal = false) {
  if (typeof userPath !== "string" || !userPath.trim() || userPath.includes("\0")) {
    throw new Error("Provide a non-empty project-relative file path.");
  }

  const portablePath = userPath.replace(/[\\/]+/g, path.sep);
  if (path.isAbsolute(portablePath) || path.win32.isAbsolute(userPath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const segments = portablePath.split(path.sep);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Paths must stay inside the project folder.");
  }
  if (process.platform === "win32" && segments.some((segment) => segment.includes(":"))) {
    throw new Error("Windows alternate data stream paths are not allowed.");
  }
  const cleanSegments = segments.filter((segment) => segment && segment !== ".");
  if (cleanSegments.length === 0) {
    throw new Error("The project folder itself is not a file.");
  }

  const root = await fs.realpath(projectRoot);
  const candidate = path.resolve(root, ...cleanSegments);
  if (!isWithin(root, candidate)) {
    throw new Error("Paths must stay inside the project folder.");
  }

  let current = root;
  for (let i = 0; i < cleanSegments.length; i += 1) {
    current = path.join(current, cleanSegments[i]);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingFinal && i < cleanSegments.length - 1) {
        try {
          await fs.mkdir(current);
        } catch (createError) {
          if (createError.code !== "EEXIST") throw createError;
        }
        stats = await fs.lstat(current);
      } else if (error.code === "ENOENT" && allowMissingFinal && i === cleanSegments.length - 1) {
        const parent = await fs.realpath(path.dirname(current));
        if (!isWithin(root, parent)) {
          throw new Error("Paths must stay inside the project folder.");
        }
        return current;
      } else {
        throw error;
      }
    }

    if (stats.isSymbolicLink()) {
      throw new Error("Symbolic links are not available to the assistant.");
    }
    if (i < cleanSegments.length - 1 && !stats.isDirectory()) {
      throw new Error("A parent path component is not a directory.");
    }
    if (i === cleanSegments.length - 1 && !stats.isFile()) {
      throw new Error("Only regular files can be read or written.");
    }
    if (i === cleanSegments.length - 1 && stats.nlink > 1) {
      throw new Error("Files linked elsewhere are not available to the assistant.");
    }
  }

  const realFile = await fs.realpath(current);
  if (!isWithin(root, realFile)) {
    throw new Error("Paths must stay inside the project folder.");
  }
  return realFile;
}

async function resolveProjectDirectory(projectRoot, userPath = ".") {
  if (typeof userPath !== "string" || userPath.includes("\0")) {
    throw new Error("Provide a project-relative folder path.");
  }
  const portablePath = userPath.replace(/[\\/]+/g, path.sep);
  if (path.isAbsolute(portablePath) || path.win32.isAbsolute(userPath)) {
    throw new Error("Absolute paths are not allowed.");
  }
  const segments = portablePath.split(path.sep);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Paths must stay inside the project folder.");
  }
  if (process.platform === "win32" && segments.some((segment) => segment.includes(":"))) {
    throw new Error("Windows alternate data stream paths are not allowed.");
  }
  const cleanSegments = segments.filter((segment) => segment && segment !== ".");
  const root = await fs.realpath(projectRoot);
  let current = root;
  for (const segment of cleanSegments) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error("Symbolic links are not available to the assistant.");
    }
    if (!stats.isDirectory()) {
      throw new Error("The requested project path is not a folder.");
    }
  }
  const realDirectory = await fs.realpath(current);
  if (!isWithin(root, realDirectory)) {
    throw new Error("Paths must stay inside the project folder.");
  }
  return realDirectory;
}

function safeFileToolError(error) {
  if (error.code === "ENOENT") return "That path does not exist inside the project folder.";
  if (error.code === "EACCES" || error.code === "EPERM") return "The requested project file is not accessible.";
  if (error.code === "EISDIR" || error.code === "ENOTDIR") return "The requested path is not a regular file.";
  return error.message || "The project file operation failed.";
}

const IGNORED_SEARCH_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "venv",
  "target"
]);

async function searchProjectFiles(projectRoot, args) {
  if (!args || typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) {
    throw new Error("Provide a search query of 1 to 200 characters.");
  }
  const query = args.query.trim().toLocaleLowerCase();
  const root = await fs.realpath(projectRoot);
  const startDirectory = await resolveProjectDirectory(projectRoot, args.path || ".");
  const directories = [startDirectory];
  const matches = [];
  let searchedFiles = 0;
  let searchedDirectories = 0;

  while (
    directories.length > 0 &&
    searchedFiles < MAX_SEARCHED_FILES &&
    searchedDirectories < MAX_SEARCHED_DIRECTORIES &&
    matches.length < MAX_SEARCH_RESULTS
  ) {
    const directory = directories.shift();
    searchedDirectories += 1;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !IGNORED_SEARCH_DIRECTORIES.has(entry.name.toLowerCase())) {
          directories.push(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || searchedFiles >= MAX_SEARCHED_FILES) continue;
      searchedFiles += 1;
      const filePath = path.join(directory, entry.name);
      try {
        const safePath = await resolveProjectFile(root, path.relative(root, filePath));
        const stats = await fs.stat(safePath);
        if (stats.size > MAX_FILE_BYTES) continue;
        const contents = await fs.readFile(safePath, "utf8");
        if (contents.includes("\0")) continue;

        const lines = contents.split(/\r?\n/);
        const relativePath = path.relative(root, safePath);
        for (let lineIndex = 0; lineIndex < lines.length && matches.length < MAX_SEARCH_RESULTS; lineIndex += 1) {
          if (!lines[lineIndex].toLocaleLowerCase().includes(query)) continue;
          const snippet = lines[lineIndex].trim().slice(0, 220);
          matches.push(`${relativePath}:${lineIndex + 1}: ${snippet}`);
        }
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "EPERM") throw error;
      }
      if (matches.length >= MAX_SEARCH_RESULTS) break;
    }
  }

  const notes = [];
  if (searchedFiles >= MAX_SEARCHED_FILES) {
    notes.push(`Search stopped after ${MAX_SEARCHED_FILES} files; narrow the folder path for more results.`);
  }
  if (searchedDirectories >= MAX_SEARCHED_DIRECTORIES) {
    notes.push(`Search stopped after ${MAX_SEARCHED_DIRECTORIES} folders; narrow the folder path for more results.`);
  }
  if (matches.length >= MAX_SEARCH_RESULTS) {
    notes.push(`Results limited to ${MAX_SEARCH_RESULTS}; narrow the query or folder path for more.`);
  }
  if (matches.length === 0) return "No matching text found in the selected project folder.";
  return [...matches, ...notes].join("\n");
}

function pickFolderWindows() {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Folder selection is currently supported on Windows only."));
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select the folder for this chat'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))) }",
    "$dialog.Dispose()"
  ].join("; ");

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-STA", "-Command", script],
      { encoding: "utf8", timeout: 300000, maxBuffer: 10000, windowsHide: false },
      (error, stdout) => {
        if (error) {
          reject(new Error("The Windows folder picker could not be opened. Close it if it is already active and try again."));
          return;
        }
        const encodedPath = stdout.trim();
        resolve(encodedPath ? Buffer.from(encodedPath, "base64").toString("utf8") : null);
      }
    );
  });
}

function getWorkspace(workspaces, id, userId) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    const error = new Error("Choose a folder before starting a chat.");
    error.statusCode = 400;
    throw error;
  }

  const workspace = workspaces.get(id);
  if (!workspace) {
    const error = new Error("This folder is not connected. Choose a folder before starting a chat.");
    error.statusCode = 400;
    throw error;
  }
  if (workspace.userId !== userId) {
    const error = new Error("This folder connection belongs to a different account.");
    error.statusCode = 403;
    throw error;
  }
  if (workspace.expiresAt <= Date.now()) {
    workspaces.delete(id);
    const error = new Error("This folder connection has expired. Choose the folder again to continue.");
    error.statusCode = 410;
    throw error;
  }
  return workspace;
}

function samePath(first, second) {
  const resolvedFirst = path.resolve(first);
  const resolvedSecond = path.resolve(second);
  return process.platform === "win32"
    ? resolvedFirst.toLowerCase() === resolvedSecond.toLowerCase()
    : resolvedFirst === resolvedSecond;
}

function getStorageFilePath(value = process.env.LOCAL_ASSISTANT_DATA_DIR) {
  const directory = value ||
    (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "LocalProjectAssistant")) ||
    path.join(os.homedir(), ".local-project-assistant");
  return path.join(path.resolve(directory), "data.json");
}

function normalizeUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim().normalize("NFKC");
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return null;
  return username;
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_HASH_BYTES, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}

function parseCookies(header = "") {
  const result = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!result.has(name)) result.set(name, value);
  }
  return result;
}

function expectedOrigin(request, port) {
  const host = request.headers.host;
  const originHeader = request.headers.origin;
  if (!host || !originHeader) return false;
  try {
    const requestUrl = new URL(`http://${host}`);
    const originUrl = new URL(originHeader);
    const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    return originUrl.protocol === "http:" &&
      allowedHosts.has(requestUrl.hostname) &&
      originUrl.hostname === requestUrl.hostname &&
      (!requestUrl.port || Number(requestUrl.port) === port) &&
      Number(originUrl.port || 80) === port;
  } catch {
    return false;
  }
}

async function loadAuthStore(storePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.users) ||
      !Array.isArray(parsed.chats)
    ) {
      throw new Error("The local account and chat store has an invalid format.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, users: [], chats: [] };
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.data-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH || value.length > 1024) {
    const error = new Error(`Password must be between ${PASSWORD_MIN_LENGTH} and 1024 characters.`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function validateChatTitle(value) {
  if (typeof value !== "string") return "New conversation";
  const title = value.replace(/\s+/g, " ").trim().slice(0, 120);
  return title || "New conversation";
}

async function passwordMatches(password, salt, expectedHash) {
  const actualHash = await hashPassword(password, Buffer.from(salt, "base64"));
  const storedHash = Buffer.from(expectedHash, "base64");
  return storedHash.length === actualHash.length && timingSafeEqual(storedHash, actualHash);
}

function chatMessagesWithinLimit(messages) {
  const retained = messages.slice(-40);
  while (retained.length > 1 && Buffer.byteLength(JSON.stringify(retained), "utf8") > MAX_STORED_CHAT_BYTES) {
    retained.shift();
  }
  if (Buffer.byteLength(JSON.stringify(retained), "utf8") > MAX_STORED_CHAT_BYTES) {
    const error = new Error("A message is too large to save in chat history.");
    error.statusCode = 400;
    throw error;
  }
  return retained;
}

function executePowerShellCommand(command, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: TERMINAL_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_TERMINAL_OUTPUT_BYTES
      },
      (error, stdout = "", stderr = "") => {
        const outputLimit = MAX_TERMINAL_OUTPUT_BYTES;
        const combinedOutput = [stdout, stderr && `STDERR:\n${stderr}`].filter(Boolean).join("\n");
        const output = Buffer.byteLength(combinedOutput, "utf8") > outputLimit
          ? `${Buffer.from(combinedOutput, "utf8").subarray(-outputLimit).toString("utf8")}\n[Earlier output omitted.]`
          : combinedOutput;
        const timedOut = Boolean(error && error.code === "ETIMEDOUT");
        resolve({
          exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
          output,
          error: error && error.code === "ENOENT"
            ? "PowerShell was not found. This terminal feature currently requires Windows PowerShell."
            : error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "Command output exceeded the terminal limit; the available output is shown below."
              : error && !Number.isInteger(error.code) && !timedOut
                ? `PowerShell could not complete the command: ${error.message}`
                : null,
          timedOut,
          durationMs: Date.now() - startedAt
        });
      }
    );
  });
}

function createFileTools(projectRoot = PROJECT_ROOT) {
  return {
    async search_project_files(args) {
      try {
        return await searchProjectFiles(projectRoot, args);
      } catch (error) {
        throw new Error(safeFileToolError(error));
      }
    },
    async list_project_files(args) {
      try {
        const directory = await resolveProjectDirectory(projectRoot, args.path);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const lines = entries.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => {
          if (entry.isSymbolicLink()) return `LINK ${entry.name} (blocked)`;
          return `${entry.isDirectory() ? "DIR " : "FILE"} ${entry.name}${entry.isDirectory() ? "/" : ""}`;
        });
        if (entries.length > MAX_DIRECTORY_ENTRIES) {
          lines.push(`... ${entries.length - MAX_DIRECTORY_ENTRIES} more entries omitted.`);
        }
        return lines.length ? lines.join("\n") : "No files or folders found.";
      } catch (error) {
        throw new Error(safeFileToolError(error));
      }
    },
    async read_project_file(args) {
      try {
        const filePath = await resolveProjectFile(projectRoot, args.path);
        const stats = await fs.stat(filePath);
        if (stats.size > MAX_FILE_BYTES) {
          throw new Error(`Files larger than ${MAX_FILE_BYTES} bytes cannot be read.`);
        }
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        throw new Error(safeFileToolError(error));
      }
    },
    async write_project_file(args) {
      try {
        if (typeof args.content !== "string") {
          throw new Error("File content must be text.");
        }
        if (Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) {
          throw new Error(`Files larger than ${MAX_FILE_BYTES} bytes cannot be written.`);
        }

        const filePath = await resolveProjectFile(projectRoot, args.path, true);
        const root = await fs.realpath(projectRoot);
        await fs.writeFile(filePath, args.content, { encoding: "utf8", flag: "w" });
        return `Saved ${path.relative(root, filePath)}.`;
      } catch (error) {
        throw new Error(safeFileToolError(error));
      }
    }
  };
}

function jsonResponse(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
    ...headers
  });
  response.end(JSON.stringify(body));
}

function writeSseEvent(response, eventName, data) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeActivityPath(userPath) {
  if (typeof userPath !== "string" || !userPath.trim() || userPath.length > 240) return "project files";
  const portablePath = userPath.trim().replace(/\\/g, "/");
  if (
    portablePath.startsWith("/") ||
    /^[a-z]:/i.test(portablePath) ||
    portablePath.split("/").some((segment) => segment === "..")
  ) {
    return "requested path (outside-project access is blocked)";
  }
  return portablePath;
}

function describeProjectActivity(toolName, args) {
  const filePath = safeActivityPath(args && (args.path || args.file_path));
  switch (toolName) {
    case "list_project_files":
      return `Listing project files · ${filePath}`;
    case "search_project_files":
      return `Searching project files · ${filePath}`;
    case "read_project_file":
      return `Reading project file · ${filePath}`;
    case "write_project_file":
      return `Updating project file · ${filePath}`;
    default:
      return "Preparing a project file operation";
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    const error = new Error("Send between 1 and 40 chat messages.");
    error.statusCode = 400;
    throw error;
  }

  return messages.map((message) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length === 0 ||
      message.content.length > 20000
    ) {
      const error = new Error("Each message must have a user or assistant role and 1–20,000 characters of text.");
      error.statusCode = 400;
      throw error;
    }
    return { role: message.role, content: message.content };
  });
}

async function ollamaFetch(baseUrl, route, options = {}) {
  const { timeoutMs = 30000, ...fetchOptions } = options;
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      ...fetchOptions,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error(`Ollama did not respond within ${Math.round(timeoutMs / 1000)} seconds. Check that Ollama is running.`);
    }
    throw new Error(
      `Cannot reach Ollama at ${baseUrl}. Open the Ollama app, or run "ollama serve" in a separate terminal. ` +
      `Then check that a model is installed with "ollama list".`
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Ollama returned an invalid response.");
  }
  if (!response.ok) {
    throw new Error(payload.error || `Ollama returned HTTP ${response.status}.`);
  }
  return payload;
}

async function ollamaChatStream(baseUrl, body, onToken) {
  const timeoutMs = CHAT_TIMEOUT_MS;
  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error(`Ollama did not respond within ${Math.round(timeoutMs / 1000)} seconds. Check that Ollama is running.`);
    }
    throw new Error(
      `Cannot reach Ollama at ${baseUrl}. Open the Ollama app, or run "ollama serve" in a separate terminal. ` +
      `Then check that a model is installed with "ollama list".`
    );
  }

  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Ollama returned an invalid response.");
    }
    throw new Error(payload.error || `Ollama returned HTTP ${response.status}.`);
  }

  if (!response.headers.get("content-type")?.includes("ndjson")) {
    try {
      const payload = await response.json();
      if (typeof payload.message?.content === "string" && payload.message.content) onToken(payload.message.content);
      return payload;
    } catch {
      throw new Error("Ollama returned an invalid response.");
    }
  }

  if (!response.body) throw new Error("Ollama did not provide a response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let toolCalls = [];
  let streamError = null;

  function processLine(line) {
    if (!line.trim()) return;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      throw new Error("Ollama returned an invalid streaming response.");
    }
    if (chunk.error) {
      streamError = chunk.error;
      return;
    }
    const message = chunk.message;
    if (typeof message?.content === "string" && message.content) {
      content += message.content;
      onToken(message.content);
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      toolCalls = message.tool_calls;
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
      if (done) break;
    }
    if (buffer.trim()) processLine(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw new Error(streamError);
  return { message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
}

function makeServerMessage() {
  return {
    role: "system",
    content: [
      "You are a careful local coding assistant, similar in workflow to a coding copilot.",
      "The user selected one existing folder for this chat. You can list, search, read, and edit files only in that folder using the supplied tools.",
      "You can create complete websites and application projects by creating the necessary source files, assets, and documentation inside the selected folder. First inspect existing files and ask about important missing requirements; for a clear request, build a coherent, usable first version and explain how to start it.",
      "Let the user describe in their own words what they want made, including purpose, audience, features, appearance, and preferred platform or technology. Treat their description and follow-up instructions as the product requirements. If key details are missing, ask focused questions before building; otherwise start implementing their request.",
      "For each request, identify its goal and constraints first. Ask concise clarifying questions only when a missing decision would materially change the result; otherwise state sensible assumptions briefly and make progress.",
      "Use the project's existing language, framework, and conventions when present. For a new project, choose a simple suitable stack based on the request, describe any dependencies, and create safe setup instructions. Do not claim a site or app is running or tested unless that actually happened; terminal commands run only after explicit user approval.",
      "For codebase questions, search for the relevant symbol or setting and read the relevant files before answering; base explanations on the actual project rather than guesses. Check existing manifests, entry points, and conventions before choosing technologies or changing structure.",
      "For requested edits, inspect relevant code first, preserve surrounding behavior, make the smallest complete change, and explain which relative paths you changed. For larger features, make a short implementation plan, complete connected changes across the necessary files, then reread the changed files and check that references and setup instructions agree.",
      "For new websites and apps, prioritize a coherent end-to-end first version: implement the main user flow, empty/loading/error states, responsive layout when relevant, accessible labels and controls, and clear run/setup instructions. Keep dependencies and architecture proportionate to the request; do not add unrelated features.",
      "The workspace includes a restricted static preview for HTML, CSS, JavaScript, and common assets in the selected folder. Prefer a self-contained front end that can be previewed directly from index.html when that fits the request; explain that backend servers, package scripts, build steps, forms, and network calls are not run by the preview and need separate terminal commands approved by the user.",
      "You may provide Windows PowerShell commands in fenced powershell blocks. The website can offer a Review & run action, but no command runs until the user separately reviews the exact command and clicks Approve and run. Never imply approval, success, or test results before the user does so and shares the terminal output.",
      "After writing or changing files, use read_project_file to reread the final contents of each changed file and verify that your saved output matches the request. Before finishing, check your work against the user's requirements, inspect relevant files, and look for missing pieces or inconsistencies. Be explicit about what you changed, how the user can run it, and any validation that still requires the user's terminal.",
      "Never claim to have run a terminal command, test, or build until the user approves the exact command and shares its result. When terminal steps are useful, label a fenced code block with the intended shell and explain what the commands do; the user must review and approve each execution in the website.",
      "Never put untrusted conversation text into a command without highlighting the substitution. Terminal commands are powerful, can affect files outside the selected folder and use the network, and must be safe and relevant to the user's request; ask before broad, destructive, or irreversible operations.",
      "Ask before making broad, destructive, or irreversible file changes."
    ].join(" ")
  };
}

function getContextLength(value = process.env.OLLAMA_NUM_CTX || DEFAULT_CONTEXT_LENGTH) {
  const contextLength = Number(value);
  if (!Number.isSafeInteger(contextLength) || contextLength < 4096 || contextLength > 262144) {
    throw new Error("OLLAMA_NUM_CTX must be a whole number between 4096 and 262144.");
  }
  return contextLength;
}

function createAppServer(options = {}) {
  const ollamaUrl = getOllamaUrl(options.ollamaUrl);
  const model = options.model || process.env.OLLAMA_MODEL || "qwen3-coder";
  const contextLength = getContextLength(options.contextLength);
  const pickFolder = options.pickFolder || pickFolderWindows;
  const workspaces = new Map();
  const authSessions = new Map();
  const terminalApprovals = new Map();
  const requireAuthentication = options.requireAuthentication !== false;
  const storagePath = options.storageFilePath || getStorageFilePath(options.dataDirectory);
  const runApprovedCommand = options.executeCommand || executePowerShellCommand;
  let authStorePromise;
  let persistQueue = Promise.resolve();
  let registrationQueue = Promise.resolve();
  let installedModels = [];
  let modelsFetchedAt = 0;

  function removeWorkspace(workspaceId) {
    workspaces.delete(workspaceId);
    for (const [approvalId, approval] of terminalApprovals) {
      if (approval.workspaceId === workspaceId) terminalApprovals.delete(approvalId);
    }
  }

  function removeUserWorkspaces(userId) {
    for (const [workspaceId, workspace] of workspaces) {
      if (workspace.userId === userId) removeWorkspace(workspaceId);
    }
  }

  function getAuthStore() {
    if (!authStorePromise) authStorePromise = loadAuthStore(storagePath);
    return authStorePromise;
  }

  function persistAuthStore(store) {
    const snapshot = JSON.parse(JSON.stringify(store));
    const nextWrite = persistQueue.catch(() => {}).then(() => atomicWriteJson(storagePath, snapshot));
    persistQueue = nextWrite;
    return nextWrite;
  }

  function currentUser(request) {
    const token = parseCookies(request.headers.cookie).get(AUTH_COOKIE);
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
    const session = authSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      authSessions.delete(token);
      removeUserWorkspaces(session.id);
      for (const [approvalId, approval] of terminalApprovals) {
        if (approval.userId === session.id) terminalApprovals.delete(approvalId);
      }
      return null;
    }
    return session;
  }

  async function authenticatedUser(request) {
    if (!requireAuthentication) return { id: "test-user", username: "test-user" };
    const session = currentUser(request);
    if (!session) {
      const error = new Error("Sign in to use saved chats and project folders.");
      error.statusCode = 401;
      throw error;
    }
    return session;
  }

  function requireSameOrigin(request, port) {
    if (requireAuthentication && !expectedOrigin(request, port)) {
      const error = new Error("This request must come from this local assistant page.");
      error.statusCode = 403;
      throw error;
    }
  }

  function createSession(user, response) {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
    authSessions.set(token, { id: user.id, username: user.username, expiresAt });
    jsonResponse(response, 200, {
      authenticated: true,
      user: { id: user.id, username: user.username },
      expiresAt: new Date(expiresAt).toISOString()
    }, {
      "set-cookie": `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`
    });
  }

  async function registerAccount(request, response, port) {
    requireSameOrigin(request, port);
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const error = new Error("Registration request must be a JSON object.");
      error.statusCode = 400;
      throw error;
    }
    const username = normalizeUsername(body.username);
    if (!username) {
      const error = new Error("Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.");
      error.statusCode = 400;
      throw error;
    }
    const password = validatePassword(body.password);
    const registration = registrationQueue.then(async () => {
      const store = await getAuthStore();
      const usernameKey = username.toLocaleLowerCase("en-US");
      if (store.users.some((user) => user.usernameKey === usernameKey)) {
        const error = new Error("That username is already registered.");
        error.statusCode = 409;
        throw error;
      }
      const salt = randomBytes(16);
      const passwordHash = await hashPassword(password, salt);
      const user = {
        id: randomUUID(),
        username,
        usernameKey,
        salt: salt.toString("base64"),
        passwordHash: passwordHash.toString("base64"),
        createdAt: new Date().toISOString()
      };
      store.users.push(user);
      await persistAuthStore(store);
      return user;
    });
    registrationQueue = registration.then(() => {}, () => {});
    const user = await registration;
    createSession(user, response);
  }

  async function loginAccount(request, response, port) {
    requireSameOrigin(request, port);
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const error = new Error("Sign-in request must be a JSON object.");
      error.statusCode = 400;
      throw error;
    }
    const username = normalizeUsername(body.username);
    if (typeof body.password !== "string" || body.password.length > 1024) {
      const error = new Error("Enter a valid username and password.");
      error.statusCode = 400;
      throw error;
    }
    const store = await getAuthStore();
    const usernameKey = username && username.toLocaleLowerCase("en-US");
    const user = usernameKey && store.users.find((entry) => entry.usernameKey === usernameKey);
    const fallbackSalt = Buffer.alloc(16, 0);
    const matches = await passwordMatches(
      body.password,
      user ? user.salt : fallbackSalt.toString("base64"),
      user ? user.passwordHash : Buffer.alloc(PASSWORD_HASH_BYTES, 0).toString("base64")
    );
    if (!user || !matches) {
      const error = new Error("Username or password is incorrect.");
      error.statusCode = 401;
      throw error;
    }
    createSession(user, response);
  }

  async function getInstalledModels(forceRefresh = false) {
    if (!forceRefresh && Date.now() - modelsFetchedAt < MODEL_CACHE_TTL_MS) {
      return installedModels;
    }
    const result = await ollamaFetch(ollamaUrl, "/api/tags", { timeoutMs: 8000 });
    installedModels = Array.isArray(result.models)
      ? result.models.filter((entry) => entry && typeof entry.name === "string").map((entry) => entry.name)
      : [];
    modelsFetchedAt = Date.now();
    return installedModels;
  }

  const server = http.createServer(async (request, response) => {
    const localPort = server.address() && server.address().port;
    try {
      const hostHeader = request.headers.host;
      const parsedHost = hostHeader ? new URL(`http://${hostHeader}`) : null;
      const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
      if (
        !parsedHost ||
        !allowedHosts.has(parsedHost.hostname) ||
        (parsedHost.port && Number(parsedHost.port) !== localPort)
      ) {
        jsonResponse(response, 403, { error: "This server accepts local browser requests only." });
        return;
      }

      if (request.headers.origin) {
        let origin;
        try {
          origin = new URL(request.headers.origin);
        } catch {
          jsonResponse(response, 403, { error: "Invalid request origin." });
          return;
        }
        if (
          origin.protocol !== "http:" ||
          !allowedHosts.has(origin.hostname) ||
          Number(origin.port || 80) !== localPort
        ) {
          jsonResponse(response, 403, { error: "Cross-origin requests are not allowed." });
          return;
        }
      }

      const url = new URL(request.url, `http://${hostHeader}`);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const body = await fs.readFile(path.join(__dirname, "public", "index.html"));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        response.end(body);
        return;
      }

      if (request.method === "GET" && ["/style.css", "/app.js"].includes(url.pathname)) {
        const filename = url.pathname === "/style.css" ? "style.css" : "app.js";
        const body = await fs.readFile(path.join(__dirname, "public", filename));
        response.writeHead(200, {
          "content-type": filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
          ...SECURITY_HEADERS
        });
        response.end(body);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const session = currentUser(request);
        if (!session) {
          jsonResponse(response, 200, { authenticated: false, user: null });
          return;
        }
        jsonResponse(response, 200, {
          authenticated: true,
          user: { id: session.id, username: session.username },
          expiresAt: new Date(session.expiresAt).toISOString()
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        await registerAccount(request, response, localPort);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        await loginAccount(request, response, localPort);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        requireSameOrigin(request, localPort);
        const token = parseCookies(request.headers.cookie).get(AUTH_COOKIE);
        const session = token && authSessions.get(token);
        if (session) {
          removeUserWorkspaces(session.id);
          for (const [approvalId, approval] of terminalApprovals) {
            if (approval.userId === session.id) terminalApprovals.delete(approvalId);
          }
        }
        if (token) authSessions.delete(token);
        jsonResponse(response, 200, { authenticated: false }, {
          "set-cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        try {
          const models = await getInstalledModels(true);
          const modelAvailable = models.includes(model) || models.includes(`${model}:latest`);
          jsonResponse(response, 200, { ollama: "connected", model, modelAvailable, models });
        } catch (error) {
          jsonResponse(response, 200, { ollama: "unavailable", model, modelAvailable: false, error: error.message });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/terminal/request") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          const error = new Error("Terminal approval request must be a JSON object.");
          error.statusCode = 400;
          throw error;
        }
        if (
          typeof body.command !== "string" ||
          !body.command.trim() ||
          body.command.length > MAX_TERMINAL_COMMAND_LENGTH ||
          body.command.includes("\0")
        ) {
          const error = new Error(`Enter a command of 1–${MAX_TERMINAL_COMMAND_LENGTH} characters without null bytes.`);
          error.statusCode = 400;
          throw error;
        }
        const workspace = getWorkspace(workspaces, body.workspaceId, user.id);
        const now = Date.now();
        for (const [approvalId, approval] of terminalApprovals) {
          if (approval.expiresAt <= now) terminalApprovals.delete(approvalId);
        }
        const pendingApprovals = [...terminalApprovals.values()]
          .filter((approval) => approval.userId === user.id);
        if (pendingApprovals.length >= 5) {
          const error = new Error("Review or discard your pending command approvals before requesting another.");
          error.statusCode = 429;
          throw error;
        }
        const approvalId = randomUUID();
        const expiresAt = now + 2 * 60 * 1000;
        terminalApprovals.set(approvalId, {
          id: approvalId,
          userId: user.id,
          workspaceId: body.workspaceId,
          command: body.command.trim(),
          expiresAt
        });
        jsonResponse(response, 200, {
          approvalId,
          command: body.command.trim(),
          folderName: workspace.name,
          expiresAt: new Date(expiresAt).toISOString()
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/terminal/approve") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        const approvalId = body && typeof body.approvalId === "string" ? body.approvalId : "";
        const approval = terminalApprovals.get(approvalId);
        if (!approval || approval.userId !== user.id) {
          const error = new Error("This command approval is invalid or belongs to another account.");
          error.statusCode = 404;
          throw error;
        }
        terminalApprovals.delete(approvalId);
        if (approval.expiresAt <= Date.now()) {
          const error = new Error("This command approval expired. Request approval again.");
          error.statusCode = 410;
          throw error;
        }
        const workspace = getWorkspace(workspaces, approval.workspaceId, user.id);
        const result = await runApprovedCommand(approval.command, workspace.root);
        jsonResponse(response, 200, {
          command: approval.command,
          folderName: workspace.name,
          ...result
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/terminal/cancel") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        const approvalId = body && typeof body.approvalId === "string" ? body.approvalId : "";
        const approval = terminalApprovals.get(approvalId);
        if (approval && approval.userId === user.id) terminalApprovals.delete(approvalId);
        jsonResponse(response, 200, { cancelled: Boolean(approval && approval.userId === user.id) });
        return;
      }

      const previewMatch = request.method === "GET"
        ? url.pathname.match(/^\/api\/preview\/([0-9a-f-]{36})(?:\/(.*))?$/i)
        : null;
      if (previewMatch) {
        const user = await authenticatedUser(request);
        const workspace = getWorkspace(workspaces, previewMatch[1], user.id);
        let requestedPath;
        try {
          requestedPath = previewMatch[2] ? decodeURIComponent(previewMatch[2]) : "index.html";
        } catch {
          const error = new Error("The preview path contains invalid URL encoding.");
          error.statusCode = 400;
          throw error;
        }

        const extension = path.extname(requestedPath).toLowerCase();
        const contentType = PREVIEW_CONTENT_TYPES.get(extension);
        if (!contentType) {
          const error = new Error("This file type is not available in the static preview.");
          error.statusCode = 415;
          throw error;
        }

        let filePath;
        try {
          filePath = await resolveProjectFile(workspace.root, requestedPath);
        } catch (error) {
          if (error.code === "ENOENT") {
            const notFound = new Error("Preview file not found in the selected folder.");
            notFound.statusCode = 404;
            throw notFound;
          }
          throw error;
        }
        const stats = await fs.stat(filePath);
        if (stats.size > MAX_PREVIEW_FILE_BYTES) {
          const error = new Error(`Preview files larger than ${MAX_PREVIEW_FILE_BYTES} bytes are not served.`);
          error.statusCode = 413;
          throw error;
        }
        const content = await fs.readFile(filePath);
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
        });
        response.end(content);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chats") {
        const user = await authenticatedUser(request);
        const store = await getAuthStore();
        const chats = store.chats
          .filter((chat) => chat.userId === user.id)
          .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
          .map((chat) => ({
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt,
            messageCount: chat.messages.length
          }));
        jsonResponse(response, 200, { chats });
        return;
      }

      const selectedChat = ["GET", "PATCH", "DELETE"].includes(request.method) &&
        /^\/api\/chats\/[0-9a-f-]{36}$/i.test(url.pathname)
        ? url.pathname.slice("/api/chats/".length)
        : null;
      if (selectedChat) {
        const user = await authenticatedUser(request);
        if (request.method !== "GET") requireSameOrigin(request, localPort);
        const store = await getAuthStore();
        const chatIndex = store.chats.findIndex((entry) => entry.id === selectedChat && entry.userId === user.id);
        if (chatIndex === -1) {
          jsonResponse(response, 404, { error: "Saved chat not found." });
          return;
        }
        const chat = store.chats[chatIndex];
        if (request.method === "PATCH") {
          const body = await readJsonBody(request);
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.title !== "string") {
            const error = new Error("Provide a chat title between 1 and 120 characters.");
            error.statusCode = 400;
            throw error;
          }
          const title = body.title.replace(/\s+/g, " ").trim();
          if (!title || title.length > 120) {
            const error = new Error("Chat titles must contain 1–120 characters.");
            error.statusCode = 400;
            throw error;
          }
          chat.title = title;
          chat.updatedAt = new Date().toISOString();
          await persistAuthStore(store);
          jsonResponse(response, 200, {
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt
          });
          return;
        }
        if (request.method === "DELETE") {
          store.chats.splice(chatIndex, 1);
          await persistAuthStore(store);
          jsonResponse(response, 200, { deleted: true, id: selectedChat });
          return;
        }
        jsonResponse(response, 200, {
          id: chat.id,
          title: chat.title,
          messages: chat.messages,
          model: chat.model,
          updatedAt: chat.updatedAt
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chats") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          const error = new Error("Saved chat request must be a JSON object.");
          error.statusCode = 400;
          throw error;
        }
        const messages = chatMessagesWithinLimit(validateMessages(body.messages));
        const store = await getAuthStore();
        const hasId = typeof body.id === "string" && body.id.length > 0;
        let chat = hasId
          ? store.chats.find((entry) => entry.id === body.id && entry.userId === user.id)
          : null;
        if (hasId && !chat) {
          const error = new Error("Saved chat not found.");
          error.statusCode = 404;
          throw error;
        }
        const firstUserMessage = messages.find((message) => message.role === "user");
        const title = validateChatTitle(body.title || (firstUserMessage && firstUserMessage.content));
        const now = new Date().toISOString();
        if (!chat) {
          const userChats = store.chats.filter((entry) => entry.userId === user.id);
          if (userChats.length >= MAX_STORED_CHATS_PER_USER) {
            const oldest = userChats.sort((first, second) => first.updatedAt.localeCompare(second.updatedAt))[0];
            store.chats = store.chats.filter((entry) => entry.id !== oldest.id);
          }
          chat = { id: randomUUID(), userId: user.id, createdAt: now };
          store.chats.push(chat);
        }
        chat.title = title;
        chat.messages = messages;
        chat.model = typeof body.model === "string" ? body.model.slice(0, 120) : model;
        chat.updatedAt = now;
        await persistAuthStore(store);
        jsonResponse(response, 200, { id: chat.id, title: chat.title, updatedAt: chat.updatedAt });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/folders/select") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          const error = new Error("Folder selection request must be a JSON object.");
          error.statusCode = 400;
          throw error;
        }
        let pickedPath;
        try {
          pickedPath = await pickFolder();
        } catch (error) {
          error.statusCode = 503;
          throw error;
        }
        if (!pickedPath) {
          jsonResponse(response, 200, { cancelled: true });
          return;
        }

        let selectedPath;
        let stats;
        try {
          selectedPath = await fs.realpath(pickedPath);
          stats = await fs.stat(selectedPath);
        } catch {
          const error = new Error("The selected folder is not accessible.");
          error.statusCode = 400;
          throw error;
        }
        if (!stats.isDirectory()) {
          const error = new Error("Select an existing folder to start this chat.");
          error.statusCode = 400;
          throw error;
        }

        const previousWorkspace = typeof body.previousWorkspaceId === "string"
          ? workspaces.get(body.previousWorkspaceId)
          : null;
        if (
          previousWorkspace &&
          previousWorkspace.userId === user.id &&
          previousWorkspace.expiresAt > Date.now() &&
          samePath(previousWorkspace.root, selectedPath)
        ) {
          const error = new Error("Choose a different existing folder for each new chat.");
          error.statusCode = 409;
          throw error;
        }

        if (
          typeof body.previousWorkspaceId === "string" &&
          previousWorkspace &&
          previousWorkspace.userId === user.id
        ) {
          removeWorkspace(body.previousWorkspaceId);
        }
        const now = Date.now();
        for (const [id, workspace] of workspaces) {
          if (workspace.expiresAt <= now) removeWorkspace(id);
        }
        while (workspaces.size >= MAX_ACTIVE_WORKSPACES) {
          removeWorkspace(workspaces.keys().next().value);
        }

        const workspaceId = randomUUID();
        const workspaceName = path.basename(selectedPath) || "Selected folder";
        workspaces.set(workspaceId, {
          root: selectedPath,
          name: workspaceName,
          userId: user.id,
          expiresAt: now + WORKSPACE_TTL_MS
        });
        jsonResponse(response, 200, { cancelled: false, workspaceId, name: workspaceName });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/folders/revoke") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        const workspace = body && typeof body.workspaceId === "string" ? workspaces.get(body.workspaceId) : null;
        if (workspace && workspace.userId === user.id) {
          removeWorkspace(body.workspaceId);
        }
        jsonResponse(response, 200, { revoked: Boolean(workspace && workspace.userId === user.id) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const user = await authenticatedUser(request);
        requireSameOrigin(request, localPort);
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          const error = new Error("Chat request must be a JSON object.");
          error.statusCode = 400;
          throw error;
        }
        const messages = validateMessages(body.messages);
        const workspace = getWorkspace(workspaces, body.workspaceId, user.id);
        const requestedModel = typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : model;
        const availableModels = await getInstalledModels();
        const selectedModel = availableModels.includes(requestedModel)
          ? requestedModel
          : availableModels.includes(`${requestedModel}:latest`)
            ? `${requestedModel}:latest`
            : null;
        if (!selectedModel) {
          const error = new Error("That model is not installed in Ollama. Refresh the model list or choose an installed model.");
          error.statusCode = 400;
          throw error;
        }
        const streamActivity = String(request.headers.accept || "").includes("text/event-stream");
        if (streamActivity) {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "connection": "keep-alive",
            "x-content-type-options": "nosniff"
          });
          response.flushHeaders();
        }
        const publishActivity = (activity) => {
          if (streamActivity) writeSseEvent(response, "activity", activity);
        };
        let activitySequence = 0;
        if (streamActivity) {
          publishActivity({
            id: activitySequence,
            message: "Reviewing your request and selected project",
            status: "running"
          });
        }
        const fileTools = createFileTools(workspace.root);
        const ollamaMessages = [makeServerMessage(), ...messages];
        let finalMessage;

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          publishActivity({
            id: 0,
            message: round === 0 ? "Thinking about your request" : "Reviewing project results and planning the next step",
            status: "running"
          });
          const result = await ollamaChatStream(ollamaUrl, {
            model: selectedModel,
            messages: ollamaMessages,
            tools: MODEL_TOOLS,
            stream: true,
            keep_alive: "10m",
            options: { num_ctx: contextLength, temperature: 0.15 }
          }, (token) => {
            if (streamActivity) writeSseEvent(response, "token", { token });
          });
          const message = result.message;
          if (!message || typeof message.content !== "string") {
            throw new Error("Ollama returned an incomplete chat response.");
          }

          const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          if (calls.length === 0) {
            publishActivity({
              id: 0,
              message: "Finished reviewing the project",
              status: "complete"
            });
            finalMessage = message.content;
            break;
          }
          if (round === MAX_TOOL_ROUNDS) {
            throw new Error("The assistant reached its file-operation limit for one reply.");
          }
          if (calls.length > MAX_TOOL_CALLS_PER_ROUND) {
            throw new Error("The assistant requested too many file operations at once.");
          }

          ollamaMessages.push(message);
          for (const call of calls) {
            const name = call.function && call.function.name;
            const tool = fileTools[name];
            let content;
            if (!tool) {
              content = `Error: Unsupported assistant tool "${name}".`;
              publishActivity({
                id: ++activitySequence,
                message: "The assistant requested an unsupported project action",
                status: "error"
              });
            } else {
              let activityId;
              let activityMessage = "Preparing a project file operation";
              try {
                const args = typeof call.function.arguments === "string"
                  ? JSON.parse(call.function.arguments)
                  : call.function.arguments;
                activityId = ++activitySequence;
                activityMessage = describeProjectActivity(name, args || {});
                publishActivity({ id: activityId, message: activityMessage, status: "running" });
                content = await tool(args || {});
                publishActivity({
                  id: activityId,
                  message: activityMessage,
                  status: String(content).startsWith("Error: ") ? "error" : "complete"
                });
              } catch (error) {
                content = `Error: ${error.message}`;
                if (activityId !== undefined) {
                  publishActivity({
                    id: activityId,
                    message: activityMessage,
                    status: "error"
                  });
                } else {
                  publishActivity({
                    id: ++activitySequence,
                    message: "Could not prepare a project file operation",
                    status: "error"
                  });
                }
              }
            }
            ollamaMessages.push({ role: "tool", tool_name: name, content: String(content) });
          }
        }

        if (typeof finalMessage !== "string") {
          throw new Error("Ollama did not return a final assistant message.");
        }
        if (streamActivity) {
          writeSseEvent(response, "result", { message: finalMessage });
          writeSseEvent(response, "done", {});
          response.end();
          return;
        }
        jsonResponse(response, 200, { message: finalMessage });
        return;
      }

      jsonResponse(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) {
        writeSseEvent(response, "error", { error: error.message || "The request could not be completed." });
        response.end();
        return;
      }
      const status = error.statusCode || (error instanceof SyntaxError ? 400 : 502);
      jsonResponse(response, status, { error: error.message || "The request could not be completed." });
    }
  });

  return server;
}

if (require.main === module) {
  try {
    const server = createAppServer();
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("PORT must be a number between 1 and 65535.");
    }
    server.listen(port, "127.0.0.1", () => {
      console.log(`Local project assistant: http://127.0.0.1:${port}`);
      console.log(`Default Ollama model: ${process.env.OLLAMA_MODEL || "qwen3-coder"}`);
      console.log(`Ollama context: ${process.env.OLLAMA_NUM_CTX || DEFAULT_CONTEXT_LENGTH} tokens`);
      console.log("Choose an existing folder in the browser for each new chat.");
      console.log("Terminal commands run only after you review and approve them in the app.");
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createAppServer, createFileTools, getOllamaUrl, resolveProjectFile };
