[简体中文](README.md) | [English](README_EN.md)

# suno-console-bridge

A lightweight tool for direct audio uploading and local credential synchronization for the Suno platform.

Many third-party user scripts synchronize user login credentials to external remote servers, which introduces security risks regarding account tokens. This project provides a fully localized, closed-loop implementation. All data flow and network requests remain strictly between your browser and your local environment, without routing through any third-party infrastructure.

The project consists of two core components: a tampermonkey user script for credential synchronization and direct uploads, along with a lightweight local Web console and command-line (CLI) interface.

### Workflow

1. When you log in to suno.com, the user script intercepts the current session's Authorization token and synchronizes it to the local service running at localhost:3000 via browser storage.
2. When an upload is initiated, the local interface requests a presigned S3 upload URL from Suno's official API.
3. Once the URL is received, the browser performs a direct binary PUT upload of the local audio file to Suno's AWS S3 bucket.
4. After the upload finishes, a confirmation request is submitted to finalize the track. If a verification challenge is required, the script resolves it directly using the active Suno page session.

### How to Use

1. Start the local server:
   Requires Python 3. No external packages or pip installations are needed.
   ```bash
   python3 server.py
   ```

2. Install the User Script:
   Copy the content of userscript.user.js from this repository and save it as a new script in Tampermonkey or Violentmonkey.

3. Log in and Upload:
   - Open and log in to suno.com in one browser tab.
   - Open http://localhost:3000 in another tab.
   - Once the bridge status indicates ready, drag and drop your audio file into the upload zone, configure the metadata, and click the upload button.

### CLI Usage

Once the initial credential synchronization has occurred in the browser, an auth_cache.json file is stored locally. You can then perform operations directly from the terminal:

Check the validity of the current credentials:
```bash
python3 cli.py status
```

Upload audio via command line:
```bash
python3 cli.py upload /path/to/music.mp3 --title "Song Title" --tags "pop, rock"
```

### Notes

- The locally generated auth_cache.json contains sensitive session tokens. Do not share it or commit it to public repositories.
- This project is intended for personal localization, educational purposes, and technical research.

### Contributors

- ANNOnElysia - Project conception and direction
- Google Gemini - Code implementation and architecture
