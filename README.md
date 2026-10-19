# Local Project Assistant for Windows

A locally hosted coding assistant with a Windows desktop window, Ollama, saved local accounts, project-folder file tools, static preview, and a command terminal that requires your approval for every command. The installed desktop app includes its own runtime; regular use does not require Node.js or a browser.

## Downloads

- **Windows installer:** [Download the latest release](https://github.com/tibormartuljak10-spec/Local-AI-assistent/releases/latest).
- **Project source ZIP:** [Download the source from the main branch](https://github.com/tibormartuljak10-spec/Local-AI-assistent/archive/refs/heads/main.zip), or use **Code → Download ZIP** on the repository page.

For most users, download the Windows installer from Releases. The source ZIP is for developers and needs Node.js to build; it does not include installed dependencies or build output.

## Build and install the Windows app

To build the installer from this source folder:

1. Install Node.js 22.12 or newer on the build PC.
2. Double-click `build-windows.bat` (or run `npm install` followed by `npm run dist:win`).
3. Run the `release\Local-Project-Assistant-Setup-*.exe` installer and finish the Windows setup wizard.
4. Start **Local Project Assistant** from its desktop or Start menu shortcut. `start.bat` launches the installed app, or opens the installer if it has not been installed yet.

The installed app checks the public GitHub Releases page for updates. When a newer version is published, use **Download v…**, then **Restart to update** in the sidebar. To publish a new version, update `package.json`'s version, push the source to GitHub, create a matching `v<version>` tag (for example, `v1.0.9`), and push the tag. The Windows release workflow builds and publishes the installer and update metadata; the repository's Actions settings must allow workflows to create releases. Earlier installers do not contain the updater, so install this updater-enabled build once before expecting automatic updates.

The installer packages the desktop runtime and app. On first setup, choose between **Qwen3 Coder** (the existing, more capable model) and **Qwen3 1.7B** (a smaller model that uses less memory and storage). Only the selected model is downloaded; you can install the other one later from the model selector. Model downloads require internet access. If `winget` is unavailable, install Ollama from the official [Windows download](https://ollama.com/download/windows), reopen the app, and use setup to download your chosen model.

You can switch between installed models at any time with the top-bar model selector. If a model is not installed, select it and choose **Install**; the app only downloads it after you confirm in the setup dialog.

Software is not installed silently: the app asks before starting setup. Once set up, Ollama and the model run on this PC; chat prompts are not sent to a cloud API.

## Use the assistant

1. Start the desktop app and create a local account or sign in.
2. Choose an existing project folder using the Windows folder picker.
3. Describe the website, app, or code change you want. The assistant can inspect, search, read, and edit files inside that chosen folder.
4. Watch the live **Project activity** panel in chat to see when the assistant is thinking, listing or searching project files, reading a file, or updating one. Each file action shows its project-relative path and whether it succeeded.
5. Rename or delete saved conversations with the pencil and × buttons beside a chat in the sidebar. Deletion asks for confirmation, then removes the chat from the sidebar immediately; disconnecting its temporary folder happens afterward.
6. Choose **Preview** and select **Find page** to locate common HTML entry points, or enter a project-relative path yourself. Preview is for static HTML/CSS/JavaScript; it does not run backend servers.
7. Open **Terminal** for common command shortcuts or enter a Windows PowerShell command. Shortcuts only fill the command; you can edit it before requesting approval. Read the exact command and choose **Approve and run** only if you trust it. You can also select **Review & run** on a PowerShell code block in chat.

Each new chat connects to a folder you choose. Folder access tokens and paths are temporary and are not saved with chat history. Sign in again after restarting the app; saved chats remain on this PC.

## Terminal and folder access

The assistant's file tools are limited to the selected project folder. Approved Windows PowerShell commands are different: they run as your Windows account and can access other files, modify the PC, install software, or use the network. This is not an operating-system sandbox. Review every command carefully. Each approval is one-time; requests time out after two minutes. A separate server or other process launched by a command may continue running after the request times out or the app closes.

The app's local web server binds to loopback only. The static preview is sandboxed and blocks network requests and form submissions; it does not run backend servers or build scripts. Use an appropriate project command such as `npm run dev` from Terminal to start a server. Every command still needs your approval; commands time out after two minutes, but a separately started server may continue running. Previewing a running server is not currently supported inside the sandboxed static preview.

## Local data and configuration

Account records and saved conversations are stored in `%LOCALAPPDATA%\LocalProjectAssistant\data.json` (or `~/.local-project-assistant/data.json` if `LOCALAPPDATA` is unavailable). Passwords are stored as salted scrypt hashes. Keep the data file on a trusted Windows account. This is a local single-user app, not an internet-facing service.

Optional environment variables can be set before starting the desktop app from a terminal:

```powershell
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen3-coder"
$env:OLLAMA_NUM_CTX = "32768"
npm run start:desktop
```

The Ollama endpoint must be local HTTP (`localhost`, `127.0.0.1`, or `::1`). Context length can be adjusted from 4096 to 262144; larger values use more memory. The model can be changed with `OLLAMA_MODEL`, or selected from the model menu when installed in Ollama.

## Tests

Run the focused test suite from this source folder:

```powershell
npm test
```
