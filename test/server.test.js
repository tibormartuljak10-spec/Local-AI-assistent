const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAppServer, createFileTools, getOllamaUrl } = require("../server");

async function start(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createUnauthenticatedTestServer(options = {}) {
  return createAppServer({ ...options, requireAuthentication: false });
}

test("Ollama endpoint accepts loopback HTTP URLs only", () => {
  assert.equal(getOllamaUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.throws(() => getOllamaUrl("https://localhost:11434"), /localhost/);
  assert.throws(() => getOllamaUrl("http://example.com:11434"), /localhost/);
  assert.throws(() => createAppServer({ contextLength: 1024 }), /OLLAMA_NUM_CTX/);
  assert.throws(() => createAppServer({ contextLength: 262145 }), /OLLAMA_NUM_CTX/);
});

test("Windows desktop build packages a standalone x64 installer and embeds local setup", async () => {
  const appPackage = JSON.parse(await fs.readFile(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(appPackage.main, "desktop\\main.js");
  assert.match(appPackage.scripts["dist:win"], /--win nsis --publish never/);
  assert.match(appPackage.scripts["release:win"], /--win nsis --publish always/);
  assert.equal(appPackage.repository.url, "https://github.com/tibormartuljak10-spec/Local-AI-assistent.git");
  assert.deepEqual(appPackage.build.publish[0], {
    provider: "github",
    owner: "tibormartuljak10-spec",
    repo: "Local-AI-assistent",
    releaseType: "release"
  });
  assert.equal(appPackage.build.win.target[0].target, "nsis");
  assert.deepEqual(appPackage.build.win.target[0].arch, ["x64"]);

  const desktopMain = await fs.readFile(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.match(desktopMain, /process\.platform !== "win32"/);
  assert.match(desktopMain, /winget/);
  assert.match(desktopMain, /OLLAMA_MODEL = process\.env\.OLLAMA_MODEL \|\| "qwen3-coder"/);
  assert.match(desktopMain, /\["pull", modelName\]/);
  assert.match(desktopMain, /MODEL_CHOICES = \["qwen3-coder", "qwen3:1\.7b"\]/);
  assert.match(desktopMain, /return await installOllamaAndModel\(modelName \|\| OLLAMA_MODEL\)/);
  assert.match(desktopMain, /autoUpdater\.autoDownload = false/);
  assert.match(desktopMain, /autoUpdater\.quitAndInstall\(\)/);
  const preload = await fs.readFile(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /update:download/);
  assert.match(preload, /onUpdateStatus/);
  const workflow = await fs.readFile(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /tags:\s*\n\s+- "v\*"/);
  assert.match(workflow, /npm run release:win/);
  assert.match(workflow, /contents: write/);
});

test("chat API explains how to recover when the local Ollama server is unavailable", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-offline-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const unavailableOllama = http.createServer();
  const ollamaUrl = await start(unavailableOllama);
  await stop(unavailableOllama);

  const app = createUnauthenticatedTestServer({
    ollamaUrl,
    model: "test-model",
    pickFolder: async () => projectRoot
  });
  const appUrl = await start(app);
  t.after(() => stop(app));

  const folderResponse = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const folder = await folderResponse.json();
  assert.equal(folderResponse.status, 200);

  const chatResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: folder.workspaceId,
      messages: [{ role: "user", content: "Hello" }]
    })
  });
  assert.equal(chatResponse.status, 502);
  const result = await chatResponse.json();
  assert.match(result.error, /Cannot reach Ollama at/);
  assert.match(result.error, /Open the Ollama app/);
  assert.match(result.error, /ollama serve/);
  assert.match(result.error, /ollama list/);
});

test("static preview serves only selected project files with restrictive headers", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-preview-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "assets"));
  await fs.writeFile(path.join(projectRoot, "index.html"), "<h1>Project preview</h1>", "utf8");
  await fs.writeFile(path.join(projectRoot, "assets", "site.css"), "body { color: blue; }", "utf8");
  await fs.writeFile(path.join(projectRoot, "server.exe"), "not previewable", "utf8");
  const ollama = http.createServer();
  const ollamaUrl = await start(ollama);
  const app = createUnauthenticatedTestServer({
    ollamaUrl,
    pickFolder: async () => projectRoot
  });
  const appUrl = await start(app);
  t.after(async () => {
    await stop(app);
    await stop(ollama);
  });

  const select = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const folder = await select.json();
  assert.equal(select.status, 200);
  const previewUrl = `${appUrl}/api/preview/${folder.workspaceId}`;
  const page = await fetch(previewUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.match(page.headers.get("content-security-policy"), /form-action 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await page.text(), "<h1>Project preview</h1>");

  const asset = await fetch(`${previewUrl}/assets/site.css`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /text\/css/);
  assert.equal(await asset.text(), "body { color: blue; }");
  assert.equal((await fetch(`${previewUrl}/server.exe`)).status, 415);
  assert.equal((await fetch(`${previewUrl}/missing.html`)).status, 404);

  const revoke = await fetch(`${appUrl}/api/folders/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: folder.workspaceId })
  });
  assert.deepEqual(await revoke.json(), { revoked: true });
  assert.equal((await fetch(previewUrl)).status, 400);
});

test("file tools read and write regular files in the project folder", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, "existing.txt"), "before", "utf8");
  const tools = createFileTools(projectRoot);

  assert.match(await tools.list_project_files({ path: "." }), /FILE existing\.txt/);
  assert.equal(await tools.read_project_file({ path: "existing.txt" }), "before");
  assert.equal(await tools.write_project_file({ path: "new.txt", content: "created" }), "Saved new.txt.");
  assert.equal(await fs.readFile(path.join(projectRoot, "new.txt"), "utf8"), "created");
  assert.equal(
    await tools.write_project_file({ path: "generated/nested/file.txt", content: "nested file" }),
    `Saved ${path.join("generated", "nested", "file.txt")}.`
  );
  assert.equal(
    await fs.readFile(path.join(projectRoot, "generated", "nested", "file.txt"), "utf8"),
    "nested file"
  );
  assert.equal(await tools.write_project_file({ path: "existing.txt", content: "after" }), "Saved existing.txt.");
  assert.equal(await fs.readFile(path.join(projectRoot, "existing.txt"), "utf8"), "after");
});

test("file tools search code in the selected folder without searching dependencies", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-search-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "src"));
  await fs.mkdir(path.join(projectRoot, "node_modules", "dependency"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "app.js"), "function selectedFolderHelper() {}\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "node_modules", "dependency", "ignored.js"), "selectedFolderHelper\n", "utf8");
  const tools = createFileTools(projectRoot);

  const matches = await tools.search_project_files({ query: "selectedFolderHelper" });
  assert.match(matches, /src[\\/]app\.js:1: function selectedFolderHelper/);
  assert.doesNotMatch(matches, /node_modules/);
  assert.match(await tools.search_project_files({ query: "missing-symbol" }), /No matching text/);
  await assert.rejects(tools.search_project_files({ query: "secret", path: "../" }), /inside the project folder/);
});

test("file tools reject traversal and absolute paths", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outsidePath = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-outside.txt`);
  await fs.writeFile(outsidePath, "outside", "utf8");
  t.after(() => fs.rm(outsidePath, { force: true }));
  const tools = createFileTools(projectRoot);

  await assert.rejects(tools.read_project_file({ path: "../" + path.basename(outsidePath) }), /inside the project folder/);
  await assert.rejects(tools.read_project_file({ path: outsidePath }), /Absolute paths/);
  await assert.rejects(tools.write_project_file({ path: "../escape.txt", content: "no" }), /inside the project folder/);
});

test("file tools refuse symbolic links", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-target-"));
  t.after(() => fs.rm(outsideDirectory, { recursive: true, force: true }));
  await fs.writeFile(path.join(outsideDirectory, "outside.txt"), "outside", "utf8");

  try {
    await fs.symlink(
      outsideDirectory,
      path.join(projectRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) {
      t.skip("Symbolic links are not available in this environment.");
      return;
    }
    throw error;
  }
  const tools = createFileTools(projectRoot);
  await assert.rejects(tools.read_project_file({ path: "linked/outside.txt" }), /Symbolic links/);
  await assert.rejects(tools.write_project_file({ path: "linked/new.txt", content: "no" }), /Symbolic links/);
  await assert.rejects(tools.list_project_files({ path: "linked" }), /Symbolic links/);
});

test("file tools refuse hard links to files outside the project", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outsidePath = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-hardlink-target.txt`);
  t.after(() => fs.rm(outsidePath, { force: true }));
  await fs.writeFile(outsidePath, "outside", "utf8");

  try {
    await fs.link(outsidePath, path.join(projectRoot, "linked.txt"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Hard links are not available in this environment.");
      return;
    }
    throw error;
  }
  const tools = createFileTools(projectRoot);
  await assert.rejects(tools.read_project_file({ path: "linked.txt" }), /linked elsewhere/);
  await assert.rejects(tools.write_project_file({ path: "linked.txt", content: "no" }), /linked elsewhere/);
  assert.equal(await fs.readFile(outsidePath, "utf8"), "outside");
});

test("chat API provides local model status and proxies validated chat messages", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  let receivedChat;
  const ollama = http.createServer(async (request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "test-model:latest" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedChat = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    const userMessage = [...receivedChat.messages].reverse().find((message) => message.role === "user");
    const hasToolResult = receivedChat.messages.some((message) => message.role === "tool");
    if (userMessage.content === "Create a project file." && !hasToolResult) {
      response.end(JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            function: {
              name: "write_project_file",
              arguments: { path: "assistant-created.txt", content: "created by the local assistant" }
            }
          }]
        }
      }));
      return;
    }
    response.end(JSON.stringify({
      message: {
        role: "assistant",
        content: hasToolResult ? "The file is saved." : "Hello from Ollama."
      }
    }));
  });
  const ollamaUrl = await start(ollama);
  const app = createUnauthenticatedTestServer({
    ollamaUrl,
    model: "test-model",
    pickFolder: async () => projectRoot
  });
  const appUrl = await start(app);
  t.after(async () => {
    await stop(app);
    await stop(ollama);
  });

  const statusResponse = await fetch(`${appUrl}/api/status`);
  assert.deepEqual(await statusResponse.json(), {
    ollama: "connected",
    model: "test-model",
    modelAvailable: true,
    models: ["test-model:latest"]
  });

  const pageResponse = await fetch(appUrl);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'self'/);
  const page = await pageResponse.text();
  assert.match(page, /Tell the assistant what website, app, or feature you want to make/);
  assert.match(page, /Build my idea/);
  assert.match(page, /Describe what you want to make/);
  assert.match(page, />Preview</);
  assert.match(page, /id="preview-find"/);
  assert.match(page, /data-terminal-command="npm run dev"/);
  assert.match(page, /data-terminal-command="npm test"/);
  assert.match(page, /id="terminal-preview"/);
  assert.match(page, /id="app-update-button"/);
  assert.match(page, /id="setup-model-select"/);
  assert.match(page, /Qwen3 1\.7B · smaller, uses less memory/);
  assert.match(page, /id="model-install"/);
  assert.match(page, />Terminal</);
  assert.match(page, /id="terminal-approval-dialog"/);
  assert.match(page, /Commands run as your Windows account/);
  assert.match(page, /id="desktop-setup-dialog"/);
  assert.match(page, /Install Ollama \+ model/);
  assert.match(page, /id="activity-panel"/);
  assert.match(page, /aria-label="Assistant project activity"/);
  assert.match(page, /id="chat-management-dialog"/);
  assert.match(page, /id="chat-title-input"/);
  assert.match(page, /sandbox="allow-scripts"/);
  const scriptResponse = await fetch(`${appUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
  const script = await scriptResponse.text();
  assert.match(script, /^async function requestTerminalApproval/m);
  assert.match(script, /function resetTerminalState\(\)/);
  assert.match(script, /window\.desktopApi\.installOllamaAndModel/);
  assert.match(script, /async function readChatActivityStream/);
  assert.match(script, /accept: "text\/event-stream"/);
  assert.match(script, /async function findPreviewPage\(\)/);
  assert.match(script, /No common HTML entry page was found/);
  assert.match(script, /Request needs attention/);
  assert.match(script, /Review the filled command/);
  assert.match(script, /window\.desktopApi\.checkForUpdates/);
  assert.match(script, /Restart to update/);
  assert.match(script, /Qwen3 1\.7B · smaller/);
  assert.match(script, /installOllamaAndModel\(modelToInstall\)/);
  assert.match(script, /Rename chat: \$\{chat\.title\}/);
  assert.match(script, /Delete chat: \$\{chat\.title\}/);
  const styleResponse = await fetch(`${appUrl}/style.css`);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("content-type"), /text\/css/);
  const style = await styleResponse.text();
  assert.match(style, /--accent-violet: #a371f7/);
  assert.match(style, /@keyframes aurora-drift/);
  assert.match(style, /@keyframes orbit-ring/);
  assert.match(style, /@keyframes grid-breathe/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/);

  const selectionResponse = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(selectionResponse.status, 200);
  const selection = await selectionResponse.json();
  assert.equal(selection.name, path.basename(projectRoot));
  assert.equal(selection.cancelled, false);
  assert.equal(JSON.stringify(selection).includes(projectRoot), false);

  const noFolderResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(noFolderResponse.status, 400);

  const chatResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: selection.workspaceId, messages: [{ role: "user", content: "Say hello." }] })
  });
  assert.equal(chatResponse.status, 200);
  assert.deepEqual(await chatResponse.json(), { message: "Hello from Ollama." });
  assert.equal(receivedChat.model, "test-model:latest");
  assert.deepEqual(receivedChat.options, { num_ctx: 32768, temperature: 0.15 });
  assert.equal(receivedChat.keep_alive, "10m");
  assert.equal(receivedChat.messages[0].role, "system");
  assert.match(receivedChat.messages[0].content, /only in that folder/);
  assert.match(receivedChat.messages[0].content, /create complete websites and application projects/);
  assert.match(receivedChat.messages[0].content, /Let the user describe in their own words what they want made/);
  assert.match(receivedChat.messages[0].content, /Treat their description and follow-up instructions as the product requirements/);
  assert.match(receivedChat.messages[0].content, /Ask concise clarifying questions only when a missing decision would materially change the result/);
  assert.match(receivedChat.messages[0].content, /check that references and setup instructions agree/);
  assert.match(receivedChat.messages[0].content, /empty\/loading\/error states/);
  assert.match(receivedChat.messages[0].content, /restricted static preview/);
  assert.match(receivedChat.messages[0].content, /clicks Approve and run/);
  assert.match(receivedChat.messages[0].content, /read_project_file to reread the final contents of each changed file/);
  assert.match(receivedChat.messages[0].content, /Terminal commands are powerful/);
  assert.doesNotMatch(receivedChat.messages[0].content, /you have no command execution capability/);
  assert.match(receivedChat.messages[0].content, /before answering/);
  assert.equal(receivedChat.tools.some((tool) => tool.function.name === "write_project_file"), true);
  assert.equal(receivedChat.tools.some((tool) => tool.function.name === "list_project_files"), true);
  assert.equal(receivedChat.tools.some((tool) => tool.function.name === "search_project_files"), true);

  const toolResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ workspaceId: selection.workspaceId, messages: [{ role: "user", content: "Create a project file." }] })
  });
  assert.equal(toolResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const activityStream = await toolResponse.text();
  assert.match(activityStream, /event: activity/);
  assert.match(activityStream, /"message":"Updating project file · assistant-created\.txt","status":"running"/);
  assert.match(activityStream, /"message":"Updating project file · assistant-created\.txt","status":"complete"/);
  assert.match(activityStream, /event: result\ndata: \{"message":"The file is saved\."\}/);
  assert.match(activityStream, /event: done/);
  assert.equal(await fs.readFile(path.join(projectRoot, "assistant-created.txt"), "utf8"), "created by the local assistant");

  const invalidResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: selection.workspaceId, messages: [{ role: "system", content: "invalid client role" }] })
  });
  assert.equal(invalidResponse.status, 400);

  const unavailableModelResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: selection.workspaceId,
      model: "not-installed",
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(unavailableModelResponse.status, 400);
  assert.match((await unavailableModelResponse.json()).error, /not installed in Ollama/);

  const explicitlySelectedModelResponse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: selection.workspaceId,
      model: "test-model:latest",
      messages: [{ role: "user", content: "Use the selected model." }]
    })
  });
  assert.equal(explicitlySelectedModelResponse.status, 200);
  assert.equal(receivedChat.model, "test-model:latest");
});

test("new chat folder selection isolates file edits and revokes the previous folder", async (t) => {
  const firstFolder = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-first-"));
  const secondFolder = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-second-"));
  t.after(() => fs.rm(firstFolder, { recursive: true, force: true }));
  t.after(() => fs.rm(secondFolder, { recursive: true, force: true }));
  const selectedFolders = [firstFolder, secondFolder];
  let selectionIndex = 0;
  const ollama = http.createServer(async (request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "test-model" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const chat = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const lastUser = [...chat.messages].reverse().find((message) => message.role === "user");
    const hasToolResult = chat.messages.some((message) => message.role === "tool");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      message: hasToolResult
        ? { role: "assistant", content: "Saved in this chat's folder." }
        : {
          role: "assistant",
          content: "",
          tool_calls: [{
            function: {
              name: "write_project_file",
              arguments: { path: "folder-specific.txt", content: lastUser.content }
            }
          }]
        }
    }));
  });
  const ollamaUrl = await start(ollama);
  const app = createUnauthenticatedTestServer({
    ollamaUrl,
    model: "test-model",
    pickFolder: async () => selectedFolders[selectionIndex++]
  });
  const appUrl = await start(app);
  t.after(async () => {
    await stop(app);
    await stop(ollama);
  });

  async function choose(previousWorkspaceId) {
    const response = await fetch(`${appUrl}/api/folders/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previousWorkspaceId })
    });
    assert.equal(response.status, 200);
    return await response.json();
  }

  async function writeInFolder(workspaceId, content) {
    return await fetch(`${appUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, messages: [{ role: "user", content }] })
    });
  }

  const first = await choose();
  assert.equal((await writeInFolder(first.workspaceId, "first folder")).status, 200);
  assert.equal(await fs.readFile(path.join(firstFolder, "folder-specific.txt"), "utf8"), "first folder");

  const second = await choose(first.workspaceId);
  assert.notEqual(second.workspaceId, first.workspaceId);
  assert.equal((await writeInFolder(second.workspaceId, "second folder")).status, 200);
  assert.equal(await fs.readFile(path.join(secondFolder, "folder-specific.txt"), "utf8"), "second folder");
  assert.equal(await fs.readFile(path.join(firstFolder, "folder-specific.txt"), "utf8"), "first folder");

  const revoked = await writeInFolder(first.workspaceId, "must not be written");
  assert.equal(revoked.status, 400);
  assert.equal(await fs.readFile(path.join(secondFolder, "folder-specific.txt"), "utf8"), "second folder");
});

test("cancelled folder picker does not create a folder connection", async (t) => {
  const ollama = http.createServer();
  const ollamaUrl = await start(ollama);
  const app = createUnauthenticatedTestServer({ ollamaUrl, pickFolder: async () => null });
  const appUrl = await start(app);
  t.after(async () => {
    await stop(app);
    await stop(ollama);
  });

  const selection = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.deepEqual(await selection.json(), { cancelled: true });
  const chat = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "00000000-0000-0000-0000-000000000000", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(chat.status, 400);
});

test("new chat requires a different folder and keeps the current chat connected if selection is rejected", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-same-folder-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const ollama = http.createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "test-model" }] }));
      return;
    }
    response.end(JSON.stringify({ message: { role: "assistant", content: "Still connected." } }));
  });
  const ollamaUrl = await start(ollama);
  const app = createUnauthenticatedTestServer({
    ollamaUrl,
    model: "test-model",
    pickFolder: async () => projectRoot
  });
  const appUrl = await start(app);
  t.after(async () => {
    await stop(app);
    await stop(ollama);
  });

  async function selectFolder(previousWorkspaceId) {
    return await fetch(`${appUrl}/api/folders/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previousWorkspaceId })
    });
  }

  const initialResponse = await selectFolder();
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  const duplicateResponse = await selectFolder(initial.workspaceId);
  assert.equal(duplicateResponse.status, 409);
  assert.match((await duplicateResponse.json()).error, /different existing folder/);

  const chat = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: initial.workspaceId, messages: [{ role: "user", content: "continue" }] })
  });
  assert.equal(chat.status, 200);
  assert.deepEqual(await chat.json(), { message: "Still connected." });
});

test("chat API rejects cross-origin browser requests", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const ollama = http.createServer();
  const ollamaUrl = await start(ollama);
  let pickerCalls = 0;
  const app = createUnauthenticatedTestServer({
    ollamaUrl,
    model: "test-model",
    pickFolder: async () => {
      pickerCalls += 1;
      return projectRoot;
    }
  });
  const appUrl = await start(app);
  t.after(async () => {
    await stop(app);
    await stop(ollama);
  });

  const response = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(response.status, 403);

  const pickerResponse = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({})
  });
  assert.equal(pickerResponse.status, 403);
  assert.equal(pickerCalls, 0);
});

test("accounts isolate and persist saved chats while sessions and folders stay temporary", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-assistant-accounts-"));
  const projectRoot = path.join(tempRoot, "chosen-project");
  const storagePath = path.join(tempRoot, "account-data", "data.json");
  await fs.mkdir(projectRoot);
  const ollama = http.createServer();
  const ollamaUrl = await start(ollama);
  const executedCommands = [];
  let app = createAppServer({
    ollamaUrl,
    storageFilePath: storagePath,
    pickFolder: async () => projectRoot,
    executeCommand: async (command, cwd) => {
      executedCommands.push({ command, cwd });
      return { exitCode: 0, output: "approved output", error: null, timedOut: false, durationMs: 2 };
    }
  });
  let appUrl = await start(app);
  t.after(async () => {
    if (app.listening) await stop(app);
    await stop(ollama);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const unauthenticatedChats = await fetch(`${appUrl}/api/chats`);
  assert.equal(unauthenticatedChats.status, 401);
  const unauthenticatedFolder = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl },
    body: JSON.stringify({})
  });
  assert.equal(unauthenticatedFolder.status, 401);

  async function authRequest(route, body, origin = appUrl) {
    return await fetch(`${appUrl}/api/auth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body)
    });
  }

  async function register(username, password = "strong-local-passphrase") {
    const response = await authRequest("register", { username, password });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    return response.headers.get("set-cookie").split(";")[0];
  }

  const missingOrigin = await authRequest("register", {
    username: "attacker",
    password: "strong-local-passphrase"
  }, null);
  assert.equal(missingOrigin.status, 403);
  const aliceCookie = await register("Alice");
  const cookieResponse = await authRequest("login", {
    username: "Alice",
    password: "strong-local-passphrase"
  });
  assert.equal(cookieResponse.status, 200);
  assert.match(cookieResponse.headers.get("set-cookie"), /HttpOnly/);
  assert.match(cookieResponse.headers.get("set-cookie"), /SameSite=Strict/);

  const folderSelection = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({})
  });
  assert.equal(folderSelection.status, 200);
  const aliceWorkspace = (await folderSelection.json()).workspaceId;
  const privatePreviewPath = path.join(projectRoot, "private.html");
  await fs.writeFile(privatePreviewPath, "<p>Alice's selected project</p>", "utf8");
  const privatePreviewUrl = `${appUrl}/api/preview/${aliceWorkspace}/private.html`;
  assert.equal((await fetch(privatePreviewUrl)).status, 401);
  const alicePreview = await fetch(privatePreviewUrl, { headers: { cookie: aliceCookie } });
  assert.equal(alicePreview.status, 200);
  assert.equal(await alicePreview.text(), "<p>Alice's selected project</p>");

  const command = "Write-Output 'approved only after review'";
  const terminalRequest = await fetch(`${appUrl}/api/terminal/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ workspaceId: aliceWorkspace, command })
  });
  assert.equal(terminalRequest.status, 200);
  const commandApproval = await terminalRequest.json();
  assert.equal(commandApproval.command, command);
  assert.equal(commandApproval.folderName, path.basename(projectRoot));
  assert.deepEqual(executedCommands, [], "requesting approval must never execute the command");
  const cancelApproval = await fetch(`${appUrl}/api/terminal/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ approvalId: commandApproval.approvalId })
  });
  assert.deepEqual(await cancelApproval.json(), { cancelled: true });
  const cancelledRun = await fetch(`${appUrl}/api/terminal/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ approvalId: commandApproval.approvalId })
  });
  assert.equal(cancelledRun.status, 404);
  assert.deepEqual(executedCommands, []);

  const approvedRequest = await fetch(`${appUrl}/api/terminal/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ workspaceId: aliceWorkspace, command })
  });
  const approved = await approvedRequest.json();
  const commandResult = await fetch(`${appUrl}/api/terminal/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ approvalId: approved.approvalId })
  });
  assert.equal(commandResult.status, 200);
  assert.equal((await commandResult.json()).output, "approved output");
  assert.deepEqual(executedCommands, [{ command, cwd: await fs.realpath(projectRoot) }]);
  const replay = await fetch(`${appUrl}/api/terminal/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ approvalId: approved.approvalId })
  });
  assert.equal(replay.status, 404);
  assert.equal(executedCommands.length, 1);

  const savedResponse = await fetch(`${appUrl}/api/chats`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({
      title: "Private project chat",
      model: "test-model",
      messages: [
        { role: "user", content: "Please inspect the private project." },
        { role: "assistant", content: "I can help with that project." }
      ]
    })
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.title, "Private project chat");

  const updateSavedResponse = await fetch(`${appUrl}/api/chats`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({
      id: saved.id,
      title: "Private project chat",
      model: "test-model",
      messages: [
        { role: "user", content: "Please inspect the private project." },
        { role: "assistant", content: "I can help with that project." },
        { role: "user", content: "Now summarize the project." },
        { role: "assistant", content: "The project summary is private." }
      ]
    })
  });
  assert.equal(updateSavedResponse.status, 200);
  assert.equal((await updateSavedResponse.json()).id, saved.id);

  const renameSavedResponse = await fetch(`${appUrl}/api/chats/${saved.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ title: "  Renamed   project chat  " })
  });
  assert.equal(renameSavedResponse.status, 200);
  const renamedChat = await renameSavedResponse.json();
  assert.equal(renamedChat.title, "Renamed project chat");
  const renamedRead = await fetch(`${appUrl}/api/chats/${saved.id}`, { headers: { cookie: aliceCookie } });
  assert.equal((await renamedRead.json()).title, "Renamed project chat");
  const invalidRename = await fetch(`${appUrl}/api/chats/${saved.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ title: "   " })
  });
  assert.equal(invalidRename.status, 400);

  const noCsrfOrigin = await fetch(`${appUrl}/api/chats`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: aliceCookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "not allowed without origin" }] })
  });
  assert.equal(noCsrfOrigin.status, 403);

  const aliceStore = JSON.parse(await fs.readFile(storagePath, "utf8"));
  assert.equal(aliceStore.users.length, 1);
  assert.equal(aliceStore.chats.length, 1);
  assert.equal(JSON.stringify(aliceStore).includes("strong-local-passphrase"), false);
  assert.equal(JSON.stringify(aliceStore).includes(projectRoot), false);

  const bobCookie = await register("Bob");
  const bobChats = await fetch(`${appUrl}/api/chats`, { headers: { cookie: bobCookie } });
  assert.deepEqual(await bobChats.json(), { chats: [] });
  assert.equal((await fetch(privatePreviewUrl, { headers: { cookie: bobCookie } })).status, 403);
  const alicePendingApproval = await fetch(`${appUrl}/api/terminal/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ workspaceId: aliceWorkspace, command })
  });
  const crossAccountApproval = await alicePendingApproval.json();
  const bobCannotApprove = await fetch(`${appUrl}/api/terminal/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: bobCookie },
    body: JSON.stringify({ approvalId: crossAccountApproval.approvalId })
  });
  assert.equal(bobCannotApprove.status, 404);
  assert.equal(executedCommands.length, 1);
  const aliceCancelsPending = await fetch(`${appUrl}/api/terminal/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ approvalId: crossAccountApproval.approvalId })
  });
  assert.deepEqual(await aliceCancelsPending.json(), { cancelled: true });
  const bobRead = await fetch(`${appUrl}/api/chats/${saved.id}`, { headers: { cookie: bobCookie } });
  assert.equal(bobRead.status, 404);
  const bobRename = await fetch(`${appUrl}/api/chats/${saved.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: appUrl, cookie: bobCookie },
    body: JSON.stringify({ title: "Unauthorized rename" })
  });
  assert.equal(bobRename.status, 404);
  const bobDelete = await fetch(`${appUrl}/api/chats/${saved.id}`, {
    method: "DELETE",
    headers: { origin: appUrl, cookie: bobCookie }
  });
  assert.equal(bobDelete.status, 404);
  const bobUpdate = await fetch(`${appUrl}/api/chats`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: bobCookie },
    body: JSON.stringify({
      id: saved.id,
      messages: [{ role: "user", content: "overwrite someone else's chat" }]
    })
  });
  assert.equal(bobUpdate.status, 404);
  const bobWorkspaceUse = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: bobCookie },
    body: JSON.stringify({
      workspaceId: aliceWorkspace,
      messages: [{ role: "user", content: "access the other account folder" }]
    })
  });
  assert.equal(bobWorkspaceUse.status, 403);
  const revokeApprovalResponse = await fetch(`${appUrl}/api/terminal/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ workspaceId: aliceWorkspace, command })
  });
  const revokeApproval = await revokeApprovalResponse.json();
  const revokeWorkspace = await fetch(`${appUrl}/api/folders/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ workspaceId: aliceWorkspace })
  });
  assert.equal(revokeWorkspace.status, 200);
  const revokedCommand = await fetch(`${appUrl}/api/terminal/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: aliceCookie },
    body: JSON.stringify({ approvalId: revokeApproval.approvalId })
  });
  assert.equal(revokedCommand.status, 404);
  assert.equal(executedCommands.length, 1);

  const duplicate = await authRequest("register", {
    username: "alice",
    password: "another-local-passphrase"
  });
  assert.equal(duplicate.status, 409);
  const wrongPassword = await authRequest("login", {
    username: "Alice",
    password: "wrong-local-passphrase"
  });
  assert.equal(wrongPassword.status, 401);

  await stop(app);
  app = createAppServer({
    ollamaUrl,
    storageFilePath: storagePath,
    pickFolder: async () => projectRoot
  });
  appUrl = await start(app);

  const expiredSession = await fetch(`${appUrl}/api/chats`, { headers: { cookie: aliceCookie } });
  assert.equal(expiredSession.status, 401);
  const login = await authRequest("login", {
    username: "alice",
    password: "strong-local-passphrase"
  });
  assert.equal(login.status, 200);
  const refreshedCookie = login.headers.get("set-cookie").split(";")[0];
  const reopened = await fetch(`${appUrl}/api/chats/${saved.id}`, { headers: { cookie: refreshedCookie } });
  assert.equal(reopened.status, 200);
  const reopenedChat = await reopened.json();
  assert.equal(reopenedChat.title, "Renamed project chat");
  assert.deepEqual(reopenedChat.messages, [
    { role: "user", content: "Please inspect the private project." },
    { role: "assistant", content: "I can help with that project." },
    { role: "user", content: "Now summarize the project." },
    { role: "assistant", content: "The project summary is private." }
  ]);
  const missingOriginDelete = await fetch(`${appUrl}/api/chats/${saved.id}`, {
    method: "DELETE",
    headers: { cookie: refreshedCookie }
  });
  assert.equal(missingOriginDelete.status, 403);
  const deleteSavedChat = await fetch(`${appUrl}/api/chats/${saved.id}`, {
    method: "DELETE",
    headers: { origin: appUrl, cookie: refreshedCookie }
  });
  assert.equal(deleteSavedChat.status, 200);
  assert.deepEqual(await deleteSavedChat.json(), { deleted: true, id: saved.id });
  assert.equal((await fetch(`${appUrl}/api/chats/${saved.id}`, { headers: { cookie: refreshedCookie } })).status, 404);
  assert.deepEqual(await (await fetch(`${appUrl}/api/chats`, { headers: { cookie: refreshedCookie } })).json(), { chats: [] });

  const needsFolder = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: refreshedCookie },
    body: JSON.stringify({
      workspaceId: aliceWorkspace,
      messages: [{ role: "user", content: "old folder must not work after restart" }]
    })
  });
  assert.equal(needsFolder.status, 400);

  await fs.writeFile(path.join(projectRoot, "index.html"), "<main>Account preview</main>", "utf8");
  const newFolderResponse = await fetch(`${appUrl}/api/folders/select`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: refreshedCookie },
    body: JSON.stringify({})
  });
  const renewedWorkspace = await newFolderResponse.json();
  assert.equal(newFolderResponse.status, 200);
  const previewUrl = `${appUrl}/api/preview/${renewedWorkspace.workspaceId}`;
  assert.equal(await (await fetch(previewUrl, { headers: { cookie: refreshedCookie } })).text(), "<main>Account preview</main>");
  const logoutApproval = await fetch(`${appUrl}/api/terminal/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: refreshedCookie },
    body: JSON.stringify({
      workspaceId: renewedWorkspace.workspaceId,
      command: "Write-Output 'must not survive sign out'"
    })
  });
  assert.equal(logoutApproval.status, 200);
  const pendingCommand = await logoutApproval.json();

  const logout = await fetch(`${appUrl}/api/auth/logout`, {
    method: "POST",
    headers: { origin: appUrl, cookie: refreshedCookie }
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${appUrl}/api/chats`, { headers: { cookie: refreshedCookie } });
  assert.equal(afterLogout.status, 401);
  const logoutRun = await fetch(`${appUrl}/api/terminal/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl, cookie: refreshedCookie },
    body: JSON.stringify({ approvalId: pendingCommand.approvalId })
  });
  assert.equal(logoutRun.status, 401);
  assert.equal((await fetch(previewUrl, { headers: { cookie: refreshedCookie } })).status, 401);
});
