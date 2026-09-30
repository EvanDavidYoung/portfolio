---
title: 'Second brain: a code walkthrough'
pubDate: '2026-09-29'
---

This walks through the code behind my [second brain](/projects/) project in the order the code actually runs on a normal day: a GitHub Actions cron fires, `slackdump` exports the workspace, the raw export goes to Google Drive, messages get turned into markdown, and two channels (`#fleeting-notes` and `#media`) go through an LLM-backed enrichment stage that writes one JSON note per message.

The repository is private, so every snippet below is copied from it as of 28 September 2026, with the file it came from above each one.

## 1. The lay of the land

```bash
git ls-files | grep -v -e 'lock' -e '\.svg$' -e '^digital-garden-canvas/\(tsconfig\|\.ox\|\.git\|index.html\|public\)'
```

```text
.github/workflows/daily-backup.yml
.gitignore
.python-version
README.md
digital-garden-canvas/README.md
digital-garden-canvas/package.json
digital-garden-canvas/src/App.tsx
digital-garden-canvas/src/SiteQueue.tsx
digital-garden-canvas/src/index.css
digital-garden-canvas/src/main.tsx
digital-garden-canvas/src/siteCard.ts
digital-garden-canvas/src/sites.ts
digital-garden-canvas/vite.config.ts
main.py
pyproject.toml
scripts/gdrive_auth.py
src/pipeline/__init__.py
src/pipeline/backup.py
src/pipeline/channels.py
src/pipeline/cli.py
src/pipeline/enrich/__init__.py
src/pipeline/enrich/config.py
src/pipeline/enrich/llm.py
src/pipeline/enrich/notes.py
src/pipeline/enrich/processors/__init__.py
src/pipeline/enrich/processors/article_summary.py
src/pipeline/enrich/processors/base.py
src/pipeline/enrich/processors/image_ocr.py
src/pipeline/enrich/processors/link.py
src/pipeline/enrich/processors/link_metadata.py
src/pipeline/enrich/processors/media_transcript.py
src/pipeline/enrich/processors/youtube.py
src/pipeline/enrich/runner.py
src/pipeline/enrich/store.py
src/pipeline/gdrive.py
src/pipeline/parser.py
src/pipeline/slackdump_runner.py
src/pipeline/state.py
src/pipeline/vault.py
tests/conftest.py
tests/test_parsing.py
tests/test_runner.py
```

There are two unrelated things in here:

* **`src/pipeline/`** is the Python package: the Slack → Drive backup plus the enrichment stage. It's almost everything, and it's what sections 2–8 cover.
* **`digital-garden-canvas/`** is a small React + Excalidraw prototype that sits on the `canvas-feature` branch. Section 9 covers it briefly.

`main.py` at the root is the leftover `uv init` stub and nothing calls it. The real entry point is declared in `pyproject.toml`:

`pyproject.toml`

```toml
[project.scripts]
pipeline = "pipeline.cli:cli"

dependencies = [
    "click>=8.4.0",
    "httpx>=0.28.1",
    "python-dateutil>=2.9.0.post0",
    "python-slugify>=8.0.4",
    "google-api-python-client>=2.170.0",
    "google-auth>=2.40.0",
    "google-auth-oauthlib>=1.2.0",
    "pillow>=11.0.0",
    "modal>=1.0.0",
    "numpy>=2.0.0",
]
```

## 2. The trigger: GitHub Actions

It all starts with `.github/workflows/daily-backup.yml`. It runs at 06:00 UTC every day, and it can also be started by hand with an optional `full` backfill checkbox:

`.github/workflows/daily-backup.yml`

```yaml
on:
  schedule:
    - cron: "0 6 * * *"  # 06:00 UTC daily
  workflow_dispatch:       # allow manual trigger from Actions UI
    inputs:
      full:
        description: "Backfill: re-fetch all history instead of the incremental window"
        type: boolean
        default: false

jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 360  # a cold GPU costs ~15 min; a full backfill needs the rest
```

The runner is a fresh Ubuntu VM, so the first steps rebuild the environment. They install the latest `slackdump` release binary and then restore the Slack credentials from two base64 secrets. `slackdump` keeps its login as an encrypted `<workspace>.bin` file plus a `workspace.txt` naming the active workspace, and both have to land in `~/.cache/slackdump`:

`.github/workflows/daily-backup.yml`

```yaml

      - name: Install slackdump
        run: |
          LATEST=$(curl -s https://api.github.com/repos/rusq/slackdump/releases/latest | jq -r '.tag_name')
          curl -fsSL "https://github.com/rusq/slackdump/releases/download/${LATEST}/slackdump_Linux_x86_64.tar.gz" \
            | tar xz slackdump
          sudo mv slackdump /usr/local/bin/

      - name: Restore slackdump workspace credentials
        run: |
          CACHE_DIR="$HOME/.cache/slackdump"
          mkdir -p "$CACHE_DIR"
          WORKSPACE_FILE=$(echo "${{ secrets.SLACKDUMP_WORKSPACE_TXT_B64 }}" | base64 -d)
          echo "$WORKSPACE_FILE" > "$CACHE_DIR/workspace.txt"
          echo "${{ secrets.SLACKDUMP_WORKSPACE_B64 }}" | base64 -d > "$CACHE_DIR/$WORKSPACE_FILE.bin"
```

The final step runs everything in **one process**. The comment explains why: the GPU starts warming at the top of the run, and enrichment reads attachments straight off the temp export before it's deleted, instead of downloading them back from Drive.

`.github/workflows/daily-backup.yml`

```yaml
      - name: Install Python dependencies
        run: uv sync

      - name: Run backup and enrichment
        env:
          SLACKDUMP_MACHINE_ID: ${{ secrets.SLACKDUMP_MACHINE_ID }}
          GDRIVE_CLIENT_ID: ${{ secrets.GDRIVE_CLIENT_ID }}
          GDRIVE_CLIENT_SECRET: ${{ secrets.GDRIVE_CLIENT_SECRET }}
          GDRIVE_REFRESH_TOKEN: ${{ secrets.GDRIVE_REFRESH_TOKEN }}
          # Enrichment: vision + text on the vllm-secondbrain A100.
          VLLM_BASE_URL: ${{ secrets.VLLM_BASE_URL }}
          VLLM_API_KEY: ${{ secrets.VLLM_API_KEY }}
          # Audio/video transcription on the podcast-transcriber Modal app.
          MODAL_TOKEN_ID: ${{ secrets.MODAL_TOKEN_ID }}
          MODAL_TOKEN_SECRET: ${{ secrets.MODAL_TOKEN_SECRET }}
        # One step, one process: the GPU starts warming at the top of the run
        # and enrichment reads attachments off the temp export before it is
        # deleted, rather than re-downloading them from Drive.
        run: uv run pipeline backup --enrich ${{ inputs.full && '--full' || '' }}
```

`SLACKDUMP_MACHINE_ID` matters. `slackdump` encrypts its credential file with a key derived from the machine ID, and a GitHub runner's machine ID is different from the laptop where you logged in. The README covers the setup: log in locally with `-machine-id=<uuid>`, then pass the same UUID in CI. Section 3.2 shows where the pipeline uses it.

## 3. The backup path

### 3.1 `cli.py`: choosing a Drive client

`uv run pipeline backup --enrich` lands in the `backup` click command. The command itself only reads environment variables and builds a Drive client. OAuth (a personal Drive, and what CI uses) wins over a service account. With no credentials at all, the run still exports, but nothing gets uploaded:

`src/pipeline/cli.py`

```python
@cli.command()
@click.option("--full", is_flag=True, default=False, help="Re-fetch all history, ignoring saved state")
@click.option("--dry-run", is_flag=True, default=False, help="Show what would run, skip export and upload")
@click.option("--slackdump-bin", default="slackdump", show_default=True, help="Path to slackdump binary")
@click.option("--enrich", "enrich_notes", is_flag=True, default=False,
              help="Also run enrichment (OCR, links, transcripts) and write JSON notes to Drive")
def backup(full: bool, dry_run: bool, slackdump_bin: str, enrich_notes: bool):
    """Export Slack via slackdump (messages + files) and archive to Google Drive."""
    import os
    from .gdrive import GDriveClient
    from .backup import run_backup

    token = os.environ.get("SLACK_TOKEN")  # optional if workspace pre-configured via slackdump
    machine_id = os.environ.get("SLACKDUMP_MACHINE_ID")

    drive = None
    if not dry_run:
        client_id = os.environ.get("GDRIVE_CLIENT_ID")
        client_secret = os.environ.get("GDRIVE_CLIENT_SECRET")
        refresh_token = os.environ.get("GDRIVE_REFRESH_TOKEN")
        service_account_b64 = os.environ.get("GDRIVE_CREDENTIALS_B64")
        shared_drive_id = os.environ.get("GDRIVE_SHARED_DRIVE_ID")

        if client_id and client_secret and refresh_token:
            drive = GDriveClient.from_oauth(client_id, client_secret, refresh_token, shared_drive_id=shared_drive_id)
        elif service_account_b64:
            drive = GDriveClient.from_service_account(service_account_b64, shared_drive_id=shared_drive_id)
        else:
            click.echo("Warning: no Drive credentials set — export will run but nothing will be uploaded.")

    run_backup(token, drive, full=full, dry_run=dry_run, slackdump_bin=slackdump_bin,
               machine_id=machine_id, enrich=enrich_notes)
```

The OAuth refresh token comes from a one-time local flow in `scripts/gdrive_auth.py`. It requests only the `drive.file` scope, which lets the app see files it created itself and nothing else in your Drive:

`scripts/gdrive_auth.py`

```python
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
SECRETS_FILE = Path(__file__).parent / "client_secrets.json"


def main() -> None:
    if not SECRETS_FILE.exists():
        print(f"Error: {SECRETS_FILE} not found.")
        print(__doc__)
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(SECRETS_FILE), scopes=SCOPES)
    creds = flow.run_local_server(port=0)

    print("\n--- Add these as GitHub secrets ---\n")
    print(f"GDRIVE_CLIENT_ID={creds.client_id}")
    print(f"GDRIVE_CLIENT_SECRET={creds.client_secret}")
    print(f"GDRIVE_REFRESH_TOKEN={creds.refresh_token}")
```

### 3.2 `backup.run_backup`: the orchestrator

`run_backup` in `src/pipeline/backup.py` is the spine of a daily run. Its first move is a cost optimisation. When `--enrich` is set, it tells the LLM client to start booting the GPU **before** anything else happens. The Slack export and Drive upload take minutes, which is about what a cold start costs, so the two overlap. The `LLMRouter` itself is covered in section 4.3.

`src/pipeline/backup.py`

```python
def run_backup(
    token: Optional[str],
    drive: Optional[GDriveClient],
    full: bool = False,
    dry_run: bool = False,
    slackdump_bin: str = "slackdump",
    machine_id: Optional[str] = None,
    enrich: bool = False,
) -> None:
    llm = None
    if enrich and not dry_run:
        # Start the GPU booting now, not when enrichment begins: the export and
        # upload below take minutes, which is roughly what a cold start costs.
        from .enrich.llm import LLMRouter

        llm = LLMRouter()
        llm.start_warm()
        click.echo("Warming the enrichment model in the background...")
```

Next it works out **how far back to export**. The only state the backup keeps is `SlackBackup/.backup-state.json` on Drive, which holds a single `last_run_date`. An incremental run exports from that date minus a 3-day `OVERLAP_DAYS` cushion, to catch late edits and out-of-order messages. A first run goes back 90 days, and `--full` goes back to the beginning:

`src/pipeline/backup.py`

```python
BACKUP_ROOT = "SlackBackup"
STATE_PATH = f"{BACKUP_ROOT}/.backup-state.json"

# Extra days back to overlap on incremental runs (guards against out-of-order messages)
OVERLAP_DAYS = 3


def load_backup_state(drive: GDriveClient) -> dict:
    data = drive.download(STATE_PATH)
    return json.loads(data) if data else {}


def save_backup_state(drive: GDriveClient, state: dict) -> None:
    drive.upload(json.dumps(state, indent=2).encode(), "application/json", STATE_PATH)

    state: dict = {}
    if drive and not full:
        click.echo("Loading backup state from Drive...")
        state = load_backup_state(drive)

    if full:
        oldest_date = None
        click.echo("Full export: fetching all history.")
    else:
        last_run = state.get("last_run_date")
        if last_run:
            oldest_date = date.fromisoformat(last_run) - timedelta(days=OVERLAP_DAYS)
        else:
            oldest_date = date.today() - timedelta(days=90)
        click.echo(f"Incremental export from {oldest_date}.")

    if dry_run:
        click.echo("[dry-run] would run: slackdump export ...")
        return
```

Everything after that happens inside a `TemporaryDirectory`, so the raw export never outlives the process. The export itself is a thin `subprocess` wrapper in `slackdump_runner.py`. `-member-only` limits it to channels you're in, v3 needs a full ISO datetime for `-time-from`, and the machine ID is passed through as `MACHINE_ID_OVERRIDE` so the credential file copied from the laptop can be decrypted:

`src/pipeline/slackdump_runner.py`

```python
    cmd = [binary, "export", "-o", str(output_dir), "-member-only"]
    if oldest_date:
        # slackdump v3 requires full ISO datetime
        cmd.extend(["-time-from", f"{oldest_date.isoformat()}T00:00:00"])

    env = os.environ.copy()
    if machine_id:
        env["MACHINE_ID_OVERRIDE"] = machine_id
    if token:
        cmd.append("-load-env")
        env["SLACK_TOKEN"] = token

    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError(
            f"slackdump exited {result.returncode}:\n{result.stderr or result.stdout}"
        )
```

A slackdump export directory contains `users.json`, `channels.json`, one folder per channel holding one `YYYY-MM-DD.json` per day, and an `__uploads/<FILE_ID>/<filename>` tree of downloaded attachments. That layout matters twice below.

### 3.3 Uploading the raw export, and the `drive_file_map`

The whole export is mirrored to `SlackBackup/exports/<today>/`. `upload_directory` returns `{relative_path: drive_file_id}`, and `run_backup` then picks out the `__uploads/<slack_file_id>/…` entries to build **`drive_file_map`**, which maps each Slack file ID to a permanent Drive view URL. The markdown and the enriched notes both link to attachments through this map, because the local temp paths disappear at the end of the run.

`src/pipeline/backup.py`

```python
        # Upload raw export (JSON + downloaded images) to Drive
        drive_file_map: dict[str, str] = {}  # slack_file_id → Drive view URL
        if drive:
            today = date.today().isoformat()
            click.echo(f"Uploading raw export to Drive (SlackBackup/exports/{today}/)...")
            uploaded = drive.upload_directory(export_dir, f"{BACKUP_ROOT}/exports/{today}")
            click.echo(f"  {len(uploaded)} file(s) uploaded.")

            # Build slack_file_id → Drive view URL from the __uploads/ portion
            for rel_path, drive_id in uploaded.items():
                parts = Path(rel_path).parts
                if len(parts) >= 3 and parts[0] == "__uploads":
                    slack_file_id = parts[1]
                    drive_file_map[slack_file_id] = (
                        f"https://drive.google.com/file/d/{drive_id}/view"
                    )
            if drive_file_map:
                click.echo(f"  {len(drive_file_map)} file attachment(s) mapped to Drive URLs.")
```

### 3.4 `gdrive.py`: Drive as a path-addressed filesystem

The Drive API has no concept of paths. Files have IDs and parent IDs. `GDriveClient` adds the missing layer. `upload("A/B/c.json")` walks or creates the folder chain (memoised in `_folder_cache`), then either **updates** a same-named file in place or creates one. Upload is therefore an idempotent overwrite, which is what makes re-running a day safe:

`src/pipeline/gdrive.py`

```python
    def upload(self, data: bytes, mime_type: str, drive_path: str) -> str:
        """Upload bytes to drive_path (e.g. "SlackBackup/general/2024-01-15.json"). Returns file ID."""
        parts = drive_path.split("/")
        filename = parts[-1]
        folder_parts = parts[:-1]

        parent_id = self._root
        if folder_parts:
            parent_id = self._ensure_folder_path(folder_parts, self._root)

        existing_id = self._find_file(filename, parent_id)
        media = MediaIoBaseUpload(BytesIO(data), mimetype=mime_type, resumable=False)

        if existing_id:
            self._svc.files().update(
                fileId=existing_id, media_body=media, supportsAllDrives=True
            ).execute()
            return existing_id
        else:
            meta = {"name": filename, "parents": [parent_id]}
            f = self._svc.files().create(
                body=meta, media_body=media, fields="id", supportsAllDrives=True
            ).execute()
            return f["id"]
```

`src/pipeline/gdrive.py`

```python
    def _find_folder(self, name: str, parent_id: str) -> str | None:
        safe = name.replace("'", "\\'")
        q = f"name='{safe}' and '{parent_id}' in parents and mimeType='{FOLDER_MIME}' and trashed=false"
        resp = self._svc.files().list(
            q=q, fields="files(id)", pageSize=1,
            supportsAllDrives=True, includeItemsFromAllDrives=True,
        ).execute()
        files = resp.get("files", [])
        return files[0]["id"] if files else None
```

Every lookup is a `files().list` query on name + parent + mime type, and the `supportsAllDrives` flags let the same code work against a Shared Drive when `GDRIVE_SHARED_DRIVE_ID` is set. `download()` mirrors `upload()`, except that it uses `_find_folder_path`, which returns `None` instead of creating anything. That's how "no state file yet" comes back as `{}`.

### 3.5 `parser.py`: Slack JSON → `Message` objects

Once the raw upload is done, `run_backup` goes through every channel folder (skipping `__uploads` and other `_`-prefixed dirs) and parses it. Both the markdown path and the enrichment path go through `parse_channel`, so the dataclasses it produces are the lingua franca of the codebase:

`src/pipeline/parser.py`

```python
@dataclass
class FileAttachment:
    id: str
    name: str
    filetype: str
    local_path: Optional[Path] = None  # set if file exists in __uploads/
    url: Optional[str] = None          # set for external files (gsheet, etc.)


@dataclass
class Message:
    ts: float
    user_id: str
    display_name: str
    text: str
    created: datetime
    edited: Optional[datetime] = None
    thread_ts: Optional[float] = None
    is_reply: bool = False
    attachments: list[FileAttachment] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
```

`parse_channel` reads every day-file in a channel, drops system subtypes (joins, topic changes…) and bots, and filters on `since_ts`. It resolves each attachment to a local file in `__uploads/<id>/` when slackdump downloaded one, and otherwise falls back to Slack's own URL:

`src/pipeline/parser.py`

```python
def parse_channel(channel_dir: Path, users: dict[str, str], since_ts: float = 0.0) -> list[Message]:
    """Parse all JSON files in a channel directory, returning Messages newer than since_ts."""
    uploads_dir = channel_dir.parent / "__uploads"
    messages = []
    for json_file in sorted(channel_dir.glob("*.json")):
        raw = json.loads(json_file.read_text())
        for m in raw:
            if m.get("type") != "message":
                continue
            if m.get("subtype") in SYSTEM_SUBTYPES:
                continue

            up = m.get("user_profile", {})
            user_id = m.get("user", "")

            # skip bots
            if m.get("bot_id") or (up and up.get("is_bot")):
                continue

            ts = float(m.get("ts", 0))
            if ts <= since_ts:
                continue

            dn = _display_name(up) if up else users.get(user_id, user_id)
            raw_text = m.get("text", "")
            urls = extract_urls(raw_text)
            text = _clean_text(raw_text, users)

            edited_dt = None
            if "edited" in m and m["edited"].get("ts"):
                edited_dt = _ts_to_dt(m["edited"]["ts"])

            thread_ts = float(m["thread_ts"]) if m.get("thread_ts") else None
            is_reply = thread_ts is not None and thread_ts != ts

            attachments = _parse_attachments(m.get("files", []), uploads_dir)

            messages.append(Message(
                ts=ts,
                user_id=user_id,
                display_name=dn,
                text=text,
                created=_ts_to_dt(str(ts)),
                edited=edited_dt,
                thread_ts=thread_ts,
                is_reply=is_reply,
                attachments=attachments,
                urls=urls,
            ))

    messages.sort(key=lambda m: m.ts)
    return messages
```

The subtle part is the ordering inside the loop. **URLs are extracted from the raw text before it gets cleaned.** Slack sends links as `<url|label>`, and `_clean_text` rewrites that to just `label` for readable markdown, which throws the URL away. Enrichment needs the URLs, so `extract_urls` runs first. It also HTML-unescapes (Slack escapes `&` as `&amp;`) and strips trailing punctuation. Here are both functions on one message:

```python
from pipeline.parser import extract_urls, _clean_text
raw = ("hey <@U123> read <https://example.com/a?x=1&amp;y=2|this post>, "
       "also https://youtu.be/dQw4w9WgXcQ. in <#C9|general>")
print("urls :", extract_urls(raw))
print("text :", _clean_text(raw, {"U123": "evan"}))
```

```text
urls : ['https://example.com/a?x=1&y=2', 'https://youtu.be/dQw4w9WgXcQ']
text : hey @evan read this post, also https://youtu.be/dQw4w9WgXcQ. in #general
```

### 3.6 Messages → daily markdown (`channels.py` + `vault.py`)

Before any markdown gets written, `_patch_attachments` swaps each attachment's temp `local_path` for its Drive URL from `drive_file_map`. Without that swap, the markdown would link to files under `/tmp` that no longer exist:

`src/pipeline/backup.py`

```python
def _patch_attachments(messages: list[Message], drive_file_map: dict[str, str]) -> None:
    """Swap temp local paths on attachments for permanent Drive view URLs."""
    for msg in messages:
        for att in msg.attachments:
            if att.local_path is not None and att.id in drive_file_map:
                att.url = drive_file_map[att.id]
                att.local_path = None
        for channel_dir in sorted(export_dir.iterdir()):
            if not channel_dir.is_dir() or channel_dir.name.startswith("_"):
                continue
            channel_name = channel_dir.name
            messages = parse_channel(channel_dir, users)
            if not messages:
                continue
            # Patch attachments: swap temp local paths for permanent Drive view URLs
            _patch_attachments(messages, drive_file_map)
            ingest_daily(messages, channel=channel_name, slug=channel_name, ingest_dir=ingest_dir)
            total_messages += len(messages)
            click.echo(f"  {channel_name}: {len(messages)} messages")

        click.echo(f"  Total: {total_messages} messages.")
```

`ingest_daily` writes one file per channel per UTC day, named `YYYY-MM-DD-<channel>.md`. Inside a day, `_thread_order` makes sure a thread's replies sit indented under their parent instead of scattered at their own later timestamps. Each message is keyed to its thread root's `ts` (or to its own `ts` if the parent isn't in this batch), the groups are sorted by that anchor, and each group is sorted internally:

`src/pipeline/channels.py`

```python
def _thread_order(items: list, get_msg=lambda m: m) -> list:
    """Reorder so a thread's replies immediately follow their parent.

    Each item is anchored at its thread root's ts (its own ts if it's not a
    reply, or if its parent isn't present in this batch). Threads therefore
    appear at the time they started, with replies bunched underneath in
    chronological order, instead of scattered at their own later timestamps.
    """
    present = {get_msg(it).ts for it in items}

    def anchor(it) -> float:
        m = get_msg(it)
        if m.is_reply and m.thread_ts in present:
            return m.thread_ts
        return m.ts

    groups: dict[float, list] = defaultdict(list)
    for it in items:
        groups[anchor(it)].append(it)

    ordered = []
    for root_ts in sorted(groups):
        ordered.extend(sorted(groups[root_ts], key=lambda it: get_msg(it).ts))
    return ordered
def ingest_daily(
    messages: list[Message],
    channel: str,
    slug: str,
    ingest_dir: Path,
) -> list[Path]:
    """One file per day: ingest/YYYY-MM-DD-{slug}.md"""
    written = []
    for day, msgs in sorted(_group_by_day(messages).items()):
        msgs = order_threads(msgs)
        path = ingest_dir / f"{day}-{slug}.md"
        lines = [f"# {channel} — {day}", ""]
        for m in msgs:
            lines.append(_format_message(m))
        created = msgs[0].created
        edited = max((m.edited for m in msgs if m.edited), default=None)
        write_ingest_file(path, channel, lines, created=created, edited=edited, append=path.exists())
        written.append(path)
    return written
```

`vault.write_ingest_file` adds YAML frontmatter (`created`, optional `edited`, `channel`, `source`). With `append=True` it strips the old frontmatter and appends the new lines to the existing body. The daily-backup path always writes into a fresh temp dir, so it never appends. That mode exists for the legacy `ingest` command (section 7).

Here's the whole markdown path on a tiny synthetic export. A reply posted *after* an unrelated message still ends up tucked under its parent, and the image attachment links to its Drive URL:

```python
import json, tempfile
from pathlib import Path
from pipeline.parser import parse_channel
from pipeline.backup import _patch_attachments
from pipeline.channels import ingest_daily

with tempfile.TemporaryDirectory() as d:
    export = Path(d) / "export"; ch = export / "general"; ch.mkdir(parents=True)
    (export / "__uploads" / "F1").mkdir(parents=True)
    (export / "__uploads" / "F1" / "shot.png").write_bytes(b"png")
    msgs = [
        {"type": "message", "user": "U1", "ts": "1760000000.000100", "text": "thread root",
         "thread_ts": "1760000000.000100", "files": [{"id": "F1", "name": "shot.png", "filetype": "png"}]},
        {"type": "message", "user": "U2", "ts": "1760000100.000100", "text": "unrelated"},
        {"type": "message", "user": "U2", "ts": "1760000200.000100", "text": "late reply",
         "thread_ts": "1760000000.000100"},
        {"type": "message", "subtype": "channel_join", "user": "U3", "ts": "1760000300.0", "text": "joined"},
    ]
    (ch / "2025-10-09.json").write_text(json.dumps(msgs))
    users = {"U1": "evan", "U2": "sam"}

    messages = parse_channel(ch, users)
    _patch_attachments(messages, {"F1": "https://drive.google.com/file/d/XYZ/view"})
    out = Path(d) / "ingest"; out.mkdir()
    for p in ingest_daily(messages, channel="general", slug="general", ingest_dir=out):
        print(f"--- {p.name}"); print(p.read_text())
```

```text
--- 2025-10-09-general.md
---
created: 2025-10-09T08:53:20.000100+00:00
channel: general
source: slack-export
---

# general — 2025-10-09

- **evan** [08:53]: thread root
  ![shot.png](https://drive.google.com/file/d/XYZ/view)
  - **sam** [08:56]: late reply
- **sam** [08:55]: unrelated
```

## 4. The enrichment stage

### 4.1 The hand-off

Still inside the temp directory, and before the markdown upload, `run_backup` hands the export to `run_enrichment`. It passes the `LLMRouter` that has been warming since the top of the run, plus the `drive_file_map`. The whole call is wrapped in a broad `except`, because a failed enrichment must never cost the backup:

`src/pipeline/backup.py`

```python
        # Enrich into JSON notes while the attachments are still on local disk:
        # OCR reads the temp files directly, and the notes reference the
        # permanent Drive URLs resolved above.
        if enrich and llm is not None:
            from .enrich.runner import run_enrichment
            from .enrich.store import DriveNoteStore, LocalNoteStore

            click.echo("Enriching notes...")
            store = (
                DriveNoteStore(drive)
                if drive
                else LocalNoteStore(Path(tmpdir) / "notes")
            )
            try:
                run_enrichment(
                    export_dir=export_dir,
                    store=store,
                    users=users,
                    llm=llm,
                    drive_file_map=drive_file_map,
                    echo=click.echo,
                )
            except Exception as exc:
                # A failed enrichment must not cost us the backup itself.
                click.echo(f"  Enrichment failed: {exc}")
            finally:
                llm.close()
```

### 4.2 `enrich/config.py`: every knob in one place

The config module is worth reading before the rest because it explains the cost model. One detail stands out: `env_file_first` gives a repo-root `.env` **precedence over** the process environment, the reverse of the usual convention. That's deliberate: a shell profile exporting a different deployment's `VLLM_API_KEY` otherwise shadows the right one and produces a confusing 401. In CI there is no `.env`, so the secrets come straight from the environment.

`src/pipeline/enrich/config.py`

```python
def env_file_first(name: str, default: str = "") -> str:
    """Read config with .env taking precedence over the exported environment.

    Deliberately the reverse of the usual precedence: a shell profile may export
    a VLLM_API_KEY belonging to a different deployment, which otherwise shadows
    the one in .env and produces a confusing 401.
    """
    return _dotenv().get(name) or os.environ.get(name, default)
def secondbrain() -> Endpoint:
    """The A100 Qwen3-VL deployment: vision and text both run here."""
    return Endpoint(
        name="vllm-secondbrain",
        base_url=env_file_first("VLLM_BASE_URL"),
        api_key=env_file_first("VLLM_API_KEY"),
        # The deployment serves the abliterated build, and vLLM 404s on any
        # other id. Confirmed against GET /v1/models.
        model=env_file_first(
            "VLLM_MODEL", "huihui-ai/Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated"
        ),
    )


# Which endpoint serves each kind of work. Both point at the A100 so a run wakes
# exactly one GPU — boot plus the idle tail dominates the bill at this volume,
# so a second endpoint costs far more than the tokens it would save. Switching
# text to another deployment is a change to this table alone.
ROUTES: dict[str, str] = {"vision": "secondbrain", "text": "secondbrain"}

ENDPOINTS = {"secondbrain": secondbrain}


def endpoint_for(kind: str) -> Endpoint:
    return ENDPOINTS[ROUTES[kind]]()


# Channels whose messages become notes. The channel is the note type — there is
# no categorization step.
ENRICH_CHANNELS = {"fleeting-notes", "media"}
```

Both kinds of work (`vision` and `text`) route to the same A100 deployment, because at this volume the bill is dominated by GPU boot plus the idle tail, not by tokens. The remaining constants are concurrency and timeout budgets:

`src/pipeline/enrich/config.py`

```python
# Notes whose only failures are soft (a YouTube summary that isn't published
# yet, say) are retried by later runs for this long, then left alone.
WARNING_RETRY_DAYS = 7

# vllm-secondbrain is @modal.concurrent(max_inputs=32) per replica; going past
# that spins up a second A100 and doubles the cost for no gain at this volume.
MAX_INFLIGHT = int(env_file_first("ENRICH_MAX_INFLIGHT", "16"))

# A fully cold snapshot build on this deployment can take ~15 minutes.
WARM_TIMEOUT = int(env_file_first("VLLM_WARM_TIMEOUT", "900"))
WARM_POLL_INTERVAL = 5

# The vLLM web apps hold a cold request open (~150s measured) rather than
# rejecting it, so client timeouts must outlast a boot or a slow success gets
# thrown away as a failure.
FIRST_REQUEST_TIMEOUT = 600
REQUEST_TIMEOUT = 300

# Plain HTTP scraping — nothing to do with the GPU.
FETCH_TIMEOUT = 15
FETCH_MAX_BYTES = 2 * 1024 * 1024
FETCH_CONCURRENCY = 8
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Article text handed to an 86k-context model, leaving room for prompt + output.
ARTICLE_CHAR_CAP = 180_000

# Below this, a page has no article to summarize — a Spotify player or a login
# wall yields a few dozen characters of chrome. Its Open Graph metadata is still
# worth keeping; a model call on it is not.
MIN_ARTICLE_CHARS = 400

# Audio attachments transcribed on the podcast-transcriber Modal app.
AUDIO_FILETYPES = {"m4a", "mp3", "wav", "aac", "ogg", "flac"}

# Video is still carried as media so the note shape stays right, but it is not
# transcribed: the app takes the whole container, so a T4 is billed to decode
# frames that are thrown away to reach an audio track a fraction of the size.
# Flip this on once gather() extracts the audio with ffmpeg before spawning.
VIDEO_FILETYPES = {"mp4", "mov", "webm"}
TRANSCRIBE_VIDEO = env_file_first("ENRICH_TRANSCRIBE_VIDEO", "").lower() in {"1", "true", "yes"}

MEDIA_FILETYPES = AUDIO_FILETYPES | VIDEO_FILETYPES
MEDIA_MAX_BYTES = 200 * 1024 * 1024
MEDIA_LANGUAGE = env_file_first("ENRICH_MEDIA_LANGUAGE", "en")
MEDIA_TIMEOUT = 1800
```

### 4.3 The warm-up that started back in 3.2 (`enrich/llm.py`)

`LLMRouter` builds one `EndpointClient` per *distinct* endpoint. Both routes point at `secondbrain`, so there's exactly one client and one GPU to wake. `start_warm()` spawns a daemon thread and returns immediately:

`src/pipeline/enrich/llm.py`

```python
class LLMRouter:
    """Routes each kind of work to its endpoint and runs calls as one batch."""

    def __init__(self, routes: Optional[dict] = None, max_inflight: Optional[int] = None):
        routes = routes or config.ROUTES
        self.max_inflight = max_inflight or config.MAX_INFLIGHT
        # One client per distinct endpoint, so a run warms each GPU only once.
        self._clients: dict[str, EndpointClient] = {}
        self._by_kind: dict[str, EndpointClient] = {}
        for kind, endpoint_name in routes.items():
            if endpoint_name not in self._clients:
                self._clients[endpoint_name] = EndpointClient(config.ENDPOINTS[endpoint_name]())
            self._by_kind[kind] = self._clients[endpoint_name]

    def start_warm(self) -> None:
        for client in self._clients.values():
            client.start_warm()

    def await_warm(self) -> None:
        for client in self._clients.values():
            client.await_warm()
```

The warm loop sends a 1-token `ping` over and over until it gets a 200 or runs out of `WARM_TIMEOUT` (15 min). The status codes carry meaning here. A booting Modal container answers 5xx (or holds the connection open), so those mean "keep polling". A 401/403 can only be a bad key, and a 400/404/422 usually means a wrong model id, so both of those fail fast instead of burning 15 minutes:

`src/pipeline/enrich/llm.py`

```python
    def _warm_loop(self) -> None:
        deadline = self._warm.started_at + config.WARM_TIMEOUT
        attempt = 0
        while time.monotonic() < deadline:
            attempt += 1
            remaining = deadline - time.monotonic()
            try:
                resp = self._client.post(
                    self.endpoint.chat_url,
                    json={
                        "model": self.endpoint.model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                        "stream": False,
                    },
                    timeout=httpx.Timeout(
                        connect=30.0,
                        read=min(remaining, config.FIRST_REQUEST_TIMEOUT),
                        write=60.0,
                        pool=30.0,
                    ),
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                log.debug("Warm poll %d: %s", attempt, exc)
                time.sleep(config.WARM_POLL_INTERVAL)
                continue

            if resp.status_code == 200:
                elapsed = time.monotonic() - self._warm.started_at
                log.info("%s ready after %.0fs (%d polls)", self.endpoint.name, elapsed, attempt)
                self._warm.ready = True
                return
            if resp.status_code in (401, 403):
                # A 401 is the fastest way to tell a bad token from a cold
                # backend: a booting container answers 5xx, never 401.
                self._warm.error = f"auth rejected ({resp.status_code}) — check VLLM_API_KEY"
                return
            if resp.status_code in (400, 404, 422):
                self._warm.error = f"endpoint rejected the probe ({resp.status_code}): {resp.text[:200]}"
                return
            # 502/503/504 and friends: still booting.
            log.debug("Warm poll %d: HTTP %d", attempt, resp.status_code)
            time.sleep(config.WARM_POLL_INTERVAL)

        self._warm.error = f"not ready within {config.WARM_TIMEOUT}s"
```

Nothing waits on this thread until phase 2 of the runner calls `map_batch` → `await_warm()`. By then the export, the upload and all the page scraping have usually covered the boot time.

### 4.4 `runner.py`: deciding what needs work

The runner's docstring is the best summary of the design:

`src/pipeline/enrich/runner.py`

```python
"""Three-phase orchestration of the enrichment stage.

    phase 0  warm the GPU in the background — before anything else happens
    phase 1  gather: parse, fetch, scrape, spawn transcriptions. No LLM calls.
    phase 2  burst: every LLM call the gather produced, issued at once
    phase 3  collect: fold results into notes and write them

The phases exist for cost reasons. The container is billed for wall-clock time,
so the goal is to have all the work queued and the model already awake when the
first request lands, and to keep it saturated until the last one returns.
"""
PROCESSORS = [
    (ImageOCR(), "attachments", "id"),
    (MediaTranscript(), "media", "id"),
    (LinkProcessor(), "links", "url"),
]
```

`run_enrichment` loads the enrichment state index (`SlackBackup/.enrich-state.json`, one entry per note id) and asks `_plan_for` about each message. The answer is a pair, `(should_process, allow_llm)`:

* **no entry** → new message: process it, LLM allowed.
* **`unprocessed`** (a hard failure last time) → retry with LLM, up to `MAX_ATTEMPTS = 5`, then give up.
* **processed with warnings under 7 days old** → re-check it **without** the LLM. A YouTube AI summary often appears days after upload, and the re-scrape is free. Re-billing an already-successful summary is not.
* **processed and clean, or only stale warnings** → skip.

`src/pipeline/enrich/runner.py`

```python
def _plan_for(entry: Optional[dict]) -> tuple[bool, bool]:
    """Decide whether a note needs work, and whether it may spend LLM calls.

    Returns (should_process, allow_llm).
    """
    if not entry:
        return True, True

    attempts = int(entry.get("attempts", 0))
    if entry.get("status") == notes_mod.STATUS_UNPROCESSED:
        if attempts >= MAX_ATTEMPTS:
            return False, False
        return True, True

    warnings = entry.get("warnings") or []
    if not warnings:
        return False, False
    now = datetime.now(timezone.utc)
    live = [
        w for w in warnings
        if not notes_mod.is_stale_warning(w, now, config.WARNING_RETRY_DAYS)
    ]
    if not live:
        return False, False
    # A soft failure may resolve on its own (YouTube publishing its summary, for
    # example). Re-check it, but without re-billing any LLM work that succeeded.
    return True, False
```

Here's the same function run against each kind of state entry:

```python
from datetime import datetime, timedelta, timezone
from pipeline.enrich.runner import _plan_for
now = datetime.now(timezone.utc)
fresh = (now - timedelta(days=1)).isoformat()
stale = (now - timedelta(days=10)).isoformat()
cases = {
    "new message (no entry)":        None,
    "unprocessed, 2 attempts":       {"status": "unprocessed", "attempts": 2},
    "unprocessed, 5 attempts":       {"status": "unprocessed", "attempts": 5},
    "processed, clean":              {"status": "processed", "warnings": []},
    "processed, 1-day-old warning":  {"status": "processed", "warnings": [{"last_attempt": fresh}]},
    "processed, 10-day-old warning": {"status": "processed", "warnings": [{"last_attempt": stale}]},
}
for name, entry in cases.items():
    process, llm = _plan_for(entry)
    print(f"{name:32} process={process!s:5}  allow_llm={llm}")
```

```text
new message (no entry)           process=True   allow_llm=True
unprocessed, 2 attempts          process=True   allow_llm=True
unprocessed, 5 attempts          process=False  allow_llm=False
processed, clean                 process=False  allow_llm=False
processed, 1-day-old warning     process=True   allow_llm=False
processed, 10-day-old warning    process=False  allow_llm=False
```

### 4.5 Phase 1a: note skeletons and work items

Every message that passes `_plan_for` becomes a `Note` skeleton (`enrich/notes.py`). A note is one JSON file per Slack message, keyed by the message's immutable `ts`. The **channel is the note type**, so there's no categorisation step. Audio/video files go into `media` and everything else into `attachments`, and every URL becomes a `{"url": ...}` entry in `links`:

`src/pipeline/enrich/notes.py`

```python
@dataclass
class Note:
    id: str
    note_type: str  # the Slack channel: the channel *is* the type
    date_sent: str
    date_ingested: str
    author: str
    text: str
    thread_ts: Optional[float] = None
    is_reply: bool = False
    permalink: Optional[str] = None
    status: str = STATUS_UNPROCESSED
    attachments: list[dict] = field(default_factory=list)
    links: list[dict] = field(default_factory=list)
    media: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    user_processing: dict = field(default_factory=dict)
    schema_version: int = SCHEMA_VERSION

    def to_dict(self) -> dict:
        return asdict(self)


def note_from_message(msg, channel: str) -> Note:
    """Build the un-enriched skeleton of a note from a parsed Slack message."""
    return Note(
        id=f"{msg.ts:.6f}",
        note_type=channel,
        date_sent=msg.created.astimezone().isoformat(),
        date_ingested=utc_now(),
        author=msg.display_name,
        text=msg.text,
        thread_ts=msg.thread_ts,
        is_reply=msg.is_reply,
        attachments=[_attachment(att) for att in msg.attachments
                     if att.filetype not in MEDIA_FILETYPES],
        media=[_attachment(att) for att in msg.attachments
               if att.filetype in MEDIA_FILETYPES],
        links=[{"url": url} for url in msg.urls],
    )
```

The runner then fans each note out into `WorkItem`s, one per (processor, target) pair where `processor.applies(target)` is true. The `sink`/`key_field` pair from `PROCESSORS` tells phase 3 where the result goes: an OCR result lands in `note.attachments`, matched by `id`, and a link result lands in `note.links`, matched by `url`. `--limit` is enforced here as well:

`src/pipeline/enrich/runner.py`

```python
    for channel in sorted(channels):
        channel_dir = export_dir / channel
        if not channel_dir.is_dir():
            continue
        messages = parse_channel(channel_dir, users)
        echo(f"  {channel}: {len(messages)} message(s) in export")

        for msg in messages:
            note = notes_mod.note_from_message(msg, channel)
            entry = state.get(note.id)
            should_process, allow_llm = _plan_for(entry)
            if retry_only and entry is None:
                should_process = False
            if not should_process:
                summary.skipped += 1
                continue
            if limit is not None and len(pending) >= limit and note.id not in pending:
                summary.skipped += 1
                continue

            for attachment in note.attachments + note.media:
                if attachment.get("id") in drive_file_map:
                    attachment["drive_url"] = drive_file_map[attachment["id"]]

            pending[note.id] = note
            existing[note.id] = store.get(note.id) if entry else None

            for processor, sink, key_field in PROCESSORS:
                targets = msg.attachments if processor.target == "attachment" else msg.urls
                for target in targets:
                    ctx_probe = Context(export_dir=export_dir, allow_llm=allow_llm)
                    if processor.applies(target, ctx_probe):
                        items.append(
                            WorkItem(
                                note_id=note.id,
                                processor=processor,
                                sink=sink,
                                key_field=key_field,
                                target=target,
                                allow_llm=allow_llm,
                            )
                        )
```

### 4.6 The processor contract

`processors/base.py` defines the protocol that makes batching possible. **A processor never calls the model itself.** It gathers inputs, *declares* the `Call`s it wants, and later turns the responses into fields:

`src/pipeline/enrich/processors/base.py`

```python
"""The processor contract.

Each processor handles exactly one kind of thing found in a message, and splits
its work into three stages so the runner can batch all GPU work together:

    gather()     phase 1 — fetch, read, scrape. No LLM calls.
    llm_calls()  phase 1 — declare the work; the runner issues it as one batch.
    finish()     phase 3 — turn responses into note fields.

A processor never calls the model itself. That is what makes it possible to keep
sixteen requests in flight against a single warm container instead of waking one
up for each note in turn.

Failure is deliberately two-tier: a soft failure (`Result.warnings`) means the
note is complete enough to publish and the missing piece may appear later; a
hard failure (`ProcessorError`) means something was actually broken and the note
should be retried on the next run.
"""
class ProcessorError(Exception):
    """Hard failure — the note stays `unprocessed` and is retried."""


@dataclass
class Result:
    fields: dict = field(default_factory=dict)
    warnings: list[tuple[str, str]] = field(default_factory=list)

    def warn(self, step: str, reason: str) -> "Result":
        self.warnings.append((step, reason))
        return self


@dataclass
class Context:
    """Everything a processor may need that isn't the item itself."""

    export_dir: Any = None
    uploads_dir: Any = None
    drive_file_map: dict = field(default_factory=dict)
    http: Any = None
    allow_llm: bool = True


class Processor(Protocol):
    name: str
    target: str  # "attachment" | "url"

    def applies(self, item: Any, ctx: Context) -> bool: ...

    def gather(self, item: Any, ctx: Context) -> Any: ...

    def llm_calls(self, gathered: Any) -> list[Call]: ...

    def finish(self, gathered: Any, results: list) -> Optional[Result]: ...
```

The two-tier failure model runs through everything that follows:

* **Soft** failures are `Result.warnings`. The note is still `processed`, and the warning just records what's missing (and may drive a free re-check later).
* **Hard** failures are `ProcessorError`. The note is written as `unprocessed` and fully retried next run.

Phase 1 runs `gather()` and `llm_calls()` for every item on an 8-thread pool, and catches every exception per item so that one buggy processor can't sink the run:

`src/pipeline/enrich/runner.py`

```python
    echo(f"Gathering for {len(pending)} note(s) across {len(items)} item(s)…")
    http = httpx.Client(
        headers={"User-Agent": config.USER_AGENT, "Accept-Language": "en-US,en;q=0.9"},
        timeout=config.FETCH_TIMEOUT,
        follow_redirects=True,
    )
    ctx = Context(export_dir=export_dir, drive_file_map=drive_file_map, http=http)

    def _gather(item: WorkItem) -> WorkItem:
        try:
            item.gathered = item.processor.gather(item.target, ctx)
            if item.allow_llm:
                item.calls = item.processor.llm_calls(item.gathered)
        except ProcessorError as exc:
            item.error = str(exc)
        except Exception as exc:  # a processor bug must not lose the whole run
            log.exception("Unexpected error in %s", item.processor.name)
            item.error = f"{type(exc).__name__}: {exc}"
        return item

    try:
        with ThreadPoolExecutor(max_workers=config.FETCH_CONCURRENCY,
                                thread_name_prefix="gather") as pool:
            items = list(pool.map(_gather, items))
```

### 4.7 The processors

#### `ImageOCR`: screenshots → `ocr_text` + `caption`

`gather()` reads the image straight from the temp export (that's why enrichment has to run before the temp dir is deleted) and upscales anything under 1500px on the long edge. Phone screenshots are routinely small enough that vision OCR starts dropping text. It then declares a single vision `Call` that asks for JSON:

`src/pipeline/enrich/processors/image_ocr.py`

```python
PROMPT = (
    "Read this image. Reply with a JSON object and nothing else:\n"
    '{"text": "<every word of text in the image, verbatim, preserving line '
    'breaks; empty string if there is no text>", '
    '"caption": "<one sentence describing what the image shows>"}'
)

SYSTEM = "You transcribe and describe images accurately. You reply with JSON only."
    long_edge = max(image.size)
    if long_edge < min_long_edge and long_edge > 0:
        scale = min_long_edge / long_edge
        new_size = (round(image.width * scale), round(image.height * scale))
        image = image.resize(new_size, Image.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue(), "image/png"
    def gather(self, item: Any, ctx: Context) -> dict:
        if item.local_path is None or not item.local_path.exists():
            # The file was never downloaded (external or expired) — nothing to
            # OCR, but the note itself is still fine.
            return {"attachment": item, "image": None}
        raw = item.local_path.read_bytes()
        image, mime = preprocess_image(raw)
        return {"attachment": item, "image": image, "mime": mime}

    def llm_calls(self, gathered: dict) -> list[Call]:
        if not gathered.get("image"):
            return []
        return [
            Call(
                kind="vision",
                prompt=PROMPT,
                system=SYSTEM,
                image=gathered["image"],
                mime=gathered.get("mime", "image/png"),
                max_tokens=2048,
                label=f"ocr:{gathered['attachment'].id}",
            )
        ]
```

`finish()` shows the failure tiers clearly. An attachment that was never downloaded is a soft warning. A failed model call is a `ProcessorError` (hard, retry). A response that isn't valid JSON still keeps its raw text instead of wasting the tokens:

`src/pipeline/enrich/processors/image_ocr.py`

```python
    def finish(self, gathered: dict, results: list) -> Optional[Result]:
        attachment = gathered["attachment"]
        result = Result(fields={"id": attachment.id})

        if not gathered.get("image"):
            return result.warn(self.name, "attachment_not_downloaded")

        response = results[0]
        if not response.ok:
            raise ProcessorError(f"OCR call failed: {response.error}")

        parsed = parse_json_object(response.text)
        if not parsed:
            # The model answered but not in the shape we asked for; keep the raw
            # text rather than throwing the tokens away.
            result.fields["ocr_text"] = (response.text or "").strip()
            return result.warn(self.name, "unparseable_response")

        result.fields["ocr_text"] = (parsed.get("text") or "").strip()
        result.fields["caption"] = (parsed.get("caption") or "").strip()
        if not result.fields["ocr_text"] and not result.fields["caption"]:
            result.warn(self.name, "empty_response")
        return result
```

#### `LinkProcessor`: one fetch, then article *or* YouTube treatment

`link.py` composes three helper modules so that a URL is fetched **once**. `link_metadata.fetch` streams the page with a 2 MB cap. `parse_og` pulls Open Graph tags with regexes (deliberately no HTML-parser dependency). After that the link branches. The fetch step also decides the failure tier: a network error or 5xx is transient, so it raises and gets a full retry, while a 404 or a non-HTML body won't fix itself, so it only warns:

`src/pipeline/enrich/processors/link.py`

```python
    def gather(self, item: str, ctx: Context) -> dict:
        url = item
        gathered: dict = {"url": url, "fields": {"url": url}, "warnings": [], "article_text": ""}
        is_youtube = youtube.is_youtube(url)
        gathered["fields"]["kind"] = "youtube" if is_youtube else "article"

        page = link_metadata.fetch(url, ctx.http)
        gathered["page"] = page
        if page.error or not page.html:
            reason = page.error or "empty_response"
            if reason.startswith("fetch_failed") or page.status >= 500:
                # Transient: worth a full retry, LLM call included.
                raise ProcessorError(f"could not fetch {url}: {reason}")
            # A 404 or a non-HTML body will not fix itself. Note it and move on.
            gathered["warnings"].append(("link.fetch", reason))
            return gathered

        gathered["fields"].update({k: v for k, v in link_metadata.parse_og(page).items() if v})

        if is_youtube:
            self._gather_youtube(url, page.html, ctx, gathered)
        else:
            text = article_summary.extract_text(page.html)
            if len(text) < config.MIN_ARTICLE_CHARS:
                # Keep the metadata, skip the summary: there is no article here.
                gathered["warnings"].append((
                    "link.extract",
                    "no_readable_text" if not text else "too_little_text",
                ))
            else:
                gathered["article_text"] = text
        return gathered
```

**Articles** go through `article_summary.extract_text`, a crude regex readability pass that drops `script/nav/footer/...` blocks, turns block closers into newlines and strips tags. If fewer than 400 characters survive (a Spotify player, a login wall), there's no article, so the metadata is kept and no model call is made. Otherwise the text is capped at 180k chars and one summary `Call` is declared:

```python
from pipeline.enrich.processors.article_summary import extract_text
from pipeline.enrich.processors.link_metadata import meta_content, title_tag
html = """<html><head><title>Fallback title</title>
<meta content="Why gardens beat streams" property="og:title">
<script>var tracking = 1;</script></head>
<body><nav>Home | About</nav><article><h1>Gardens</h1><p>Notes that grow &amp; change.</p>
<p>Second paragraph.</p></article><footer>(c) 2026</footer></body></html>"""
print("og:title  :", meta_content(html, "og:title"), "   (content-before-property order still matches)")
print("<title>   :", title_tag(html))
print("text      :", repr(extract_text(html)))
```

```text
og:title  : Why gardens beat streams    (content-before-property order still matches)
<title>   : Fallback title
text      : 'Fallback title \n\nGardens\n Notes that grow & change.\n\nSecond paragraph.'
```

**YouTube** links get a lot more scraping, all from the same watch-page HTML: the channel, the full description, YouTube's own AI summary and the captions. Every one of those is optional and becomes a warning when it's missing. Datacenter IPs (so, GitHub Actions) get a stripped page with no player payload, and that's why there are fallbacks: the channel comes from the public oEmbed endpoint and the description from `og:description`:

`src/pipeline/enrich/processors/link.py`

```python
    def _gather_youtube(self, url: str, html: str, ctx: Context, gathered: dict) -> None:
        video: dict = {}
        video_id = youtube.extract_youtube_id(url)
        if video_id:
            video["video_id"] = video_id

        video.update(youtube.parse_channel(html))
        if not video.get("channel"):
            # The player payload is missing — a stripped page, which is what
            # datacenter IPs get. Ask oEmbed instead of giving up.
            oembed = youtube.fetch_oembed(url, ctx.http)
            if oembed.get("channel"):
                video["channel"] = oembed["channel"]
                video.setdefault("channel_url", oembed.get("channel_url"))
                gathered["fields"].setdefault("title", oembed.get("title"))
            else:
                gathered["warnings"].append(("youtube.channel", "not_on_page"))

        description = youtube.parse_description(html)
        if description:
            video["description"] = description
        elif gathered["fields"].get("description"):
            # og:description survives on the stripped page; it is truncated
            # relative to the full description but far better than nothing.
            video["description"] = gathered["fields"]["description"]
            video["description_source"] = "og"
        else:
            gathered["warnings"].append(("youtube.description", "not_on_page"))

        ai_summary = youtube.parse_ai_summary(html)
        if ai_summary:
            video["ai_summary"] = ai_summary
        else:
            # Routinely absent for a while after upload; a later run may find it.
            gathered["warnings"].append(("youtube.ai_summary", "not_on_page"))

        transcript, reason = youtube.fetch_transcript(html, ctx.http)
        if transcript:
            video["transcript"] = transcript
        else:
            gathered["warnings"].append(("youtube.transcript", reason))

        gathered["fields"]["youtube"] = video
```

The YouTube helpers handle every URL shape a video link can take. Caption tracks can't be sliced out with a regex, because the entries contain nested arrays, so `_json_array_after` walks bracket depth while tracking string and escape state. `fetch_transcript` returns a reason code with every miss. `captions_withheld` (a 200 with an empty body) is the *normal* case for unauthenticated requests, and that code keeps it distinguishable from "this video has no captions":

```python
from pipeline.enrich.processors.youtube import extract_youtube_id, _json_array_after, parse_description
for u in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "https://youtu.be/dQw4w9WgXcQ",
          "https://youtube.com/shorts/abcDEF123", "https://m.youtube.com/live/xyz_789-a",
          "https://vimeo.com/12345"]:
    print(f"{u:48} -> {extract_youtube_id(u)}")
page = '..."captionTracks":[{"baseUrl":"u1","name":{"runs":[{"text":"English"}]}}],"other":[1]...'
print("captionTracks slice:", _json_array_after(page, "captionTracks"))
print("description:", repr(parse_description('"shortDescription":"Line one\\nCaf\\u00e9 \\"quoted\\""')))
```

```text
https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10 -> dQw4w9WgXcQ
https://youtu.be/dQw4w9WgXcQ                     -> dQw4w9WgXcQ
https://youtube.com/shorts/abcDEF123             -> abcDEF123
https://m.youtube.com/live/xyz_789-a             -> xyz_789-a
https://vimeo.com/12345                          -> None
captionTracks slice: [{"baseUrl":"u1","name":{"runs":[{"text":"English"}]}}]
description: 'Line one\nCafé "quoted"'
```

(In the article demo above, `<nav>`, `<script>` and `<footer>` are gone, but the `<title>` text survives into the body because `<head>` isn't in the drop list. That's harmless for a summary prompt that repeats the title anyway, but it's a quirk worth knowing about.)

The link's `finish()` folds in the summary. An *unreachable* model is a hard failure and not a warning, because the free warning sweep never re-issues LLM calls. If this were only a warning, the summary would never get retried:

`src/pipeline/enrich/processors/link.py`

```python
    def finish(self, gathered: dict, results: list) -> Optional[Result]:
        result = Result(fields=gathered["fields"])
        for step, reason in gathered["warnings"]:
            result.warn(step, reason)

        if results:
            response = results[0]
            if response.ok and response.text:
                result.fields["summary"] = article_summary.clean_summary(response.text)
            elif not response.ok:
                # The model was unreachable rather than unhelpful. Hard failure,
                # so the note is marked unprocessed and the whole link is retried
                # next run — the free retry sweep can't re-issue LLM calls.
                raise ProcessorError(f"summary call failed: {response.error}")
            else:
                result.warn("link.summary", "empty_response")
        return result
```

#### `MediaTranscript`: audio → the `podcast-transcriber` Modal app

Transcription runs on a separate Modal app (WhisperX on a T4), not on the chat model. So `llm_calls()` returns nothing, and the job is *spawned* during `gather()` (phase 1) and *collected* in `finish()` (phase 3). That way the T4 boots and transcribes in parallel with everything else. Video is carried on the note but not transcribed unless `ENRICH_TRANSCRIBE_VIDEO` is set, because the Modal function would decode whole video containers to reach the audio. `applies()` also returns `False` in the free retry sweep, since a T4 run costs money too:

`src/pipeline/enrich/processors/media_transcript.py`

```python
    def applies(self, item: Any, ctx: Context) -> bool:
        if item.filetype not in config.MEDIA_FILETYPES:
            return False
        # The T4 is not the chat model, but it is still paid compute, so the
        # free retry sweep must not re-spawn a job it already paid for. An
        # existing transcript survives on the note through notes._merge_list.
        return ctx.allow_llm

    def gather(self, item: Any, ctx: Context) -> dict:
        gathered: dict = {"attachment": item, "call": None, "error": None}
        if item.filetype in config.VIDEO_FILETYPES and not config.TRANSCRIBE_VIDEO:
            gathered["error"] = "video_not_transcribed"
            return gathered

        if item.local_path is None or not item.local_path.exists():
            gathered["error"] = "attachment_not_downloaded"
            return gathered

        size = item.local_path.stat().st_size
        if size > config.MEDIA_MAX_BYTES:
            gathered["error"] = f"too_large_{size // (1024 * 1024)}mb"
            return gathered

        try:
            import modal
        except ImportError as exc:
            raise ProcessorError(f"modal is required for transcription: {exc}") from exc

        try:
            fn = modal.Function.from_name(config.TRANSCRIBER_APP, config.TRANSCRIBER_FUNCTION)
            gathered["call"] = fn.spawn(
                audio_bytes=item.local_path.read_bytes(),
                filename=item.name,
                # The Modal function defaults to Chinese; Slack captures are English.
                language=config.MEDIA_LANGUAGE,
            )
        except Exception as exc:
            raise ProcessorError(f"could not spawn transcription: {exc}") from exc

        log.info("Spawned transcription for %s (%.1f MB)", item.name, size / 1024 / 1024)
        return gathered
```

`src/pipeline/enrich/processors/media_transcript.py`

```python
        try:
            payload = call.get(timeout=config.MEDIA_TIMEOUT)
        except Exception as exc:
            raise ProcessorError(f"transcription failed: {exc}") from exc

        segments = (payload or {}).get("segments", []) or []
        transcript = " ".join(
            (segment.get("text") or "").strip() for segment in segments
        ).strip()
        result.fields["transcript"] = transcript
        result.fields["language"] = (payload or {}).get("language", config.MEDIA_LANGUAGE)
        result.fields["segments"] = segments
        if not transcript:
            result.warn(self.name, "empty_transcript")
        return result
```

### 4.8 Phase 2: the burst

Back in the runner, every `Call` declared in phase 1 is flattened into one list, paired with the item it came from. If the model never came up, every call gets an error result and the affected notes are marked for retry. The notes are still written with whatever phase 1 gathered:

`src/pipeline/enrich/runner.py`

```python
        # ------------------------------------------------------------ phase 2
        batched = [(item, call) for item in items if not item.error for call in item.calls]
        summary.llm_calls = len(batched)
        if batched:
            try:
                responses = llm.map_batch([call for _, call in batched])
            except LLMUnavailable as exc:
                # Everything that needed the model is retried next run; the notes
                # still land with whatever was gathered.
                echo(f"  LLM unavailable ({exc}) — notes will be marked unprocessed.")
                responses = [CallResult(error=str(exc)) for _ in batched]
            for (item, _), response in zip(batched, responses):
                item.results.append(response)
        else:
            echo("  No LLM work in this batch.")
```

`map_batch` is where the warm-up finally gets awaited. After that, the calls go through a thread pool capped at `MAX_INFLIGHT = 16`. The endpoint allows 32 concurrent inputs per replica, and going over that would boot a second A100. `pool.map` keeps results in input order, which is what makes the `zip` above safe:

`src/pipeline/enrich/llm.py`

```python
    def map_batch(self, calls: list[Call]) -> list[CallResult]:
        """Issue every call with bounded concurrency; results keep input order."""
        if not calls:
            return []
        self.await_warm()
        inflight = min(self.max_inflight, len(calls))
        log.info("Dispatching %d LLM call(s), %d in flight", len(calls), inflight)
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=inflight, thread_name_prefix="llm") as pool:
            results = list(pool.map(lambda c: self._by_kind[c.kind].invoke(c), calls))
        failed = sum(1 for r in results if not r.ok)
        log.info(
            "Batch finished in %.0fs (%d ok, %d failed)",
            time.monotonic() - started,
            len(results) - failed,
            failed,
        )
        return results
```

Each call goes through `invoke`, which builds an OpenAI-compatible chat payload (images go inline as base64 data URLs) and retries transient errors with jittered exponential backoff. Two details are specific to Qwen3. `/no_think` is appended to every system prompt, because otherwise reasoning tokens eat the whole `max_tokens` budget and leave the content empty. And any `<think>…</think>` block that slips through gets stripped from the response:

`src/pipeline/enrich/llm.py`

```python
    def _payload(self, call: Call) -> dict:
        system = (call.system or "").strip()
        # Qwen3 emits reasoning tokens by default, which eat a small max_tokens
        # budget whole and leave content empty.
        system = f"{system} /no_think".strip()
    def invoke(self, call: Call, attempts: int = 3) -> CallResult:
        timeout = config.REQUEST_TIMEOUT if self._warm.ready else config.FIRST_REQUEST_TIMEOUT
        last_error = "unknown error"
        for attempt in range(1, attempts + 1):
            try:
                resp = self._client.post(
                    self.endpoint.chat_url,
                    json=self._payload(call),
                    timeout=httpx.Timeout(connect=30.0, read=timeout, write=120.0, pool=30.0),
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            else:
                if resp.status_code == 200:
                    return CallResult(text=_content_of(resp.json()))
                if resp.status_code in (401, 403, 400, 422):
                    return CallResult(error=f"HTTP {resp.status_code}: {resp.text[:200]}")
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            if attempt < attempts:
                backoff = min(2 ** attempt, 20) + random.uniform(0, 1)
                log.debug("Retrying %s in %.1fs (%s)", call.label or call.kind, backoff, last_error)
                time.sleep(backoff)
        return CallResult(error=last_error)

    def close(self) -> None:
        self._client.close()


def _content_of(data: dict) -> str:
    try:
        content = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""
    return _THINK_BLOCK.sub("", content).strip()
```

Model responses are parsed with `parse_json_object`, which tolerates code fences and chatter around the object:

```python
from pipeline.enrich.llm import parse_json_object
print(parse_json_object('Sure! ```json\n{"text": "hello", "caption": "a sign"}\n``` hope that helps'))
print(parse_json_object('no json here'))
```

```text
{'text': 'hello', 'caption': 'a sign'}
{}
```

### 4.9 Phase 3: fold results into notes

Each item's `finish()` runs with its responses. Errors from any stage add a warning **and** mark the note as `failed`. A successful `Result` is merged into the right list by `_apply`, using the item's `sink`/`key_field`:

`src/pipeline/enrich/runner.py`

```python
def _apply(note: notes_mod.Note, item: WorkItem, result: Result) -> None:
    """Merge a processor's output into the right list on the note."""
    target_list = getattr(note, item.sink)
    key = result.fields.get(item.key_field)
    for entry in target_list:
        if entry.get(item.key_field) == key:
            entry.update({k: v for k, v in result.fields.items() if v is not None})
            break
    else:
        target_list.append(result.fields)
        # ------------------------------------------------------------ phase 3
        for item in items:
            note = pending[item.note_id]
            if item.error:
                failed.add(note.id)
                note.warnings.append(notes_mod.warning(item.processor.name, item.error))
                continue
            try:
                result = item.processor.finish(item.gathered, item.results)
            except ProcessorError as exc:
                failed.add(note.id)
                note.warnings.append(notes_mod.warning(item.processor.name, str(exc)))
                continue
            except Exception as exc:
                log.exception("Unexpected error finishing %s", item.processor.name)
                failed.add(note.id)
                note.warnings.append(
                    notes_mod.warning(item.processor.name, f"{type(exc).__name__}: {exc}")
                )
                continue
            if result is None:
                continue
            _apply(note, item, result)
            for step, reason in result.warnings:
                note.warnings.append(notes_mod.warning(step, reason))
```

Then every pending note gets a status, is **merged with the version already in the store**, is written, and gets a state-index entry. `attempts` counts consecutive hard failures and resets to 0 on success, which is what `_plan_for`'s `MAX_ATTEMPTS` cutoff reads:

`src/pipeline/enrich/runner.py`

```python
    for note_id, note in pending.items():
        note.status = (
            notes_mod.STATUS_UNPROCESSED if note_id in failed else notes_mod.STATUS_PROCESSED
        )
        merged = notes_mod.merge(existing.get(note_id), note)
        store.put(merged)

        entry = store.state_entry(merged)
        previous = state.get(note_id) or {}
        entry["attempts"] = (
            int(previous.get("attempts", 0)) + 1
            if merged["status"] == notes_mod.STATUS_UNPROCESSED
            else 0
        )
        state[note_id] = entry

        summary.notes_written += 1
        summary.warnings += len(merged.get("warnings", []))
        for warn in merged.get("warnings", []):
            summary.reasons[(warn.get("step"), warn.get("reason"))] += 1
        if merged["status"] == notes_mod.STATUS_PROCESSED:
            summary.notes_processed += 1
        else:
            summary.notes_unprocessed += 1

    store.save_state(state)
    echo(summary.as_text())
    return summary
```

### 4.10 `notes.merge`: why a re-run never loses data

Notes get re-processed (hard-failure retries, the free 7-day warning sweep), so merging has to be lossless in both directions. `merge` keeps the original `date_ingested` and any human-written `user_processing`. List items are merged by key: fields from the new pass overwrite old ones only when they're non-`None`, and items the new pass didn't produce are kept. Warnings that repeat carry their `attempts` count forward:

`src/pipeline/enrich/notes.py`

```python
def _merge_warnings(existing: list[dict], incoming: list[dict]) -> list[dict]:
    """Carry attempt counts forward so the retry window can expire properly."""
    by_key = {(w.get("step"), w.get("reason")): dict(w) for w in existing}
    merged: list[dict] = []
    for warn in incoming:
        key = (warn.get("step"), warn.get("reason"))
        previous = by_key.get(key)
        if previous:
            warn = dict(warn)
            warn["attempts"] = int(previous.get("attempts", 1)) + 1
        merged.append(warn)
    return merged


def _merge_list(existing: list[dict], incoming: list[dict], key: str) -> list[dict]:
    """Refresh derived fields on each item without dropping ones we didn't touch."""
    by_key = {item.get(key): item for item in existing if item.get(key)}
    merged = []
    seen = set()
    for item in incoming:
        identifier = item.get(key)
        seen.add(identifier)
        if identifier in by_key:
            combined = dict(by_key[identifier])
            combined.update({k: v for k, v in item.items() if v is not None})
            merged.append(combined)
        else:
            merged.append(item)
    # Anything the new pass didn't produce (an attachment no longer downloaded,
    # say) stays rather than silently disappearing from the note.
    merged.extend(item for identifier, item in by_key.items() if identifier not in seen)
    return merged


def merge(existing: Optional[dict], note: Note) -> dict:
    """Combine a freshly enriched note with whatever is already in Drive."""
    fresh = note.to_dict()
    if not existing:
        return fresh

    fresh["date_ingested"] = existing.get("date_ingested", fresh["date_ingested"])
    fresh["user_processing"] = existing.get("user_processing") or fresh["user_processing"]
    fresh["attachments"] = _merge_list(existing.get("attachments", []), fresh["attachments"], "id")
    fresh["links"] = _merge_list(existing.get("links", []), fresh["links"], "url")
    fresh["media"] = _merge_list(existing.get("media", []), fresh["media"], "id")
    fresh["warnings"] = _merge_warnings(existing.get("warnings", []), fresh["warnings"])
    return fresh
```

Here's a free warning-sweep pass (no LLM) merged over an earlier full run. YouTube has published its AI summary since the first run, so that warning clears. The LLM `summary` from the first run survives, the user's annotation survives, and the still-missing transcript's warning moves to `attempts: 2`:

```python
import json
from pipeline.enrich.notes import Note, merge, warning
url = "https://youtu.be/dQw4w9WgXcQ"
existing = {
    "id": "1.000000", "date_ingested": "2026-09-01T06:00:00+00:00",
    "user_processing": {"tags": ["music"]},
    "links": [{"url": url, "summary": "LLM summary from run 1"}],
    "attachments": [], "media": [],
    "warnings": [{"step": "youtube.ai_summary", "reason": "not_on_page", "attempts": 1},
                 {"step": "youtube.transcript", "reason": "captions_withheld", "attempts": 1}],
}
sweep = Note(id="1.000000", note_type="media", date_sent="x", date_ingested="2026-09-03T06:00:00+00:00",
             author="evan", text="watch this", status="processed",
             links=[{"url": url, "youtube": {"ai_summary": "now published"}, "summary": None}],
             warnings=[warning("youtube.transcript", "captions_withheld")])
m = merge(existing, sweep)
print(json.dumps({k: m[k] for k in ("date_ingested", "user_processing", "links")}, indent=2))
print("warnings:", [(w["step"], w["attempts"]) for w in m["warnings"]])
```

```text
{
  "date_ingested": "2026-09-01T06:00:00+00:00",
  "user_processing": {
    "tags": [
      "music"
    ]
  },
  "links": [
    {
      "url": "https://youtu.be/dQw4w9WgXcQ",
      "summary": "LLM summary from run 1",
      "youtube": {
        "ai_summary": "now published"
      }
    }
  ]
}
warnings: [('youtube.transcript', 2)]
```

### 4.11 `store.py`: where notes live

The runner only talks to the `BaseNoteStore` interface. `DriveNoteStore` writes `SlackBackup/notes/YYYY-MM/<ts>.json` through `GDriveClient.upload` (an idempotent overwrite, see 3.4). `LocalNoteStore` writes the same layout to disk for `enrich --out`. Two design choices are in the module docstring:

`src/pipeline/enrich/store.py`

```python
"""Where notes live: Google Drive in production, a local folder while iterating.

Notes sit in one tree with a `status` field rather than being moved between
processed/ and unprocessed/ folders — a status flip is then a single in-place
write instead of a copy-plus-delete that can half-fail.

The state index is a small companion file listing what each note still needs.
Reading it costs one download; discovering the same thing by listing and
fetching every note would cost one Drive round trip per note.
"""
def month_of(note_id: str) -> str:
    try:
        ts = float(note_id)
    except ValueError:
        return "unknown"
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")


def relative_path(note_id: str) -> str:
    return f"{month_of(note_id)}/{config.safe_id(note_id)}.json"
    @staticmethod
    def state_entry(note: dict) -> dict:
        return {
            "status": note.get("status"),
            "warnings": [
                {
                    "step": w.get("step"),
                    "reason": w.get("reason"),
                    "attempts": w.get("attempts", 1),
                    "last_attempt": w.get("last_attempt"),
                }
                for w in note.get("warnings", [])
            ],
            "note_type": note.get("note_type"),
            "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        }
```

Status is a field, not a folder, so flipping `unprocessed` → `processed` is one in-place write and can't half-fail as a move. The state index exists so that `_plan_for` costs **one** Drive download per run, instead of one round trip per note.

> **An observation from tracing this.** `_plan_for` expires a warning once its `last_attempt` is 7+ days old. But `_merge_warnings` takes the *incoming* warning, which has a fresh `last_attempt`, and only carries `attempts` forward. On a daily cron, a warning that never clears (`youtube.transcript: captions_withheld` is described as the *normal* outcome) gets a new timestamp every day, so it never goes stale and the note is re-fetched forever. The re-fetch is free of LLM cost, but the number of such notes only grows. `attempts` *is* tracked, but nothing reads it for expiry. Nothing in the tests covers expiry. A daily sweep, simulated:

```python
from datetime import datetime, timedelta, timezone
from unittest import mock
from pipeline.enrich import notes
from pipeline.enrich.runner import _plan_for

day0 = datetime(2026, 9, 1, 6, tzinfo=timezone.utc)
stored = None
for day in range(10):
    now = day0 + timedelta(days=day)
    with mock.patch.object(notes, "utc_now", return_value=now.isoformat()):
        n = notes.Note(id="1.0", note_type="media", date_sent="", date_ingested="", author="", text="",
                       status="processed", warnings=[notes.warning("youtube.transcript", "captions_withheld")])
        stored = notes.merge(stored, n)
    w = stored["warnings"][0]
    later = now + timedelta(days=1)
    with mock.patch("pipeline.enrich.runner.datetime") as dt:
        dt.now.return_value = later
        process, _ = _plan_for({"status": "processed", "warnings": stored["warnings"]})
    print(f"day {day}: attempts={w['attempts']:2}  last_attempt={w['last_attempt'][:10]}  re-check next day? {process}")
```

```text
day 0: attempts= 1  last_attempt=2026-09-01  re-check next day? True
day 1: attempts= 2  last_attempt=2026-09-02  re-check next day? True
day 2: attempts= 3  last_attempt=2026-09-03  re-check next day? True
day 3: attempts= 4  last_attempt=2026-09-04  re-check next day? True
day 4: attempts= 5  last_attempt=2026-09-05  re-check next day? True
day 5: attempts= 6  last_attempt=2026-09-06  re-check next day? True
day 6: attempts= 7  last_attempt=2026-09-07  re-check next day? True
day 7: attempts= 8  last_attempt=2026-09-08  re-check next day? True
day 8: attempts= 9  last_attempt=2026-09-09  re-check next day? True
day 9: attempts=10  last_attempt=2026-09-10  re-check next day? True
```

## 5. Closing out the backup

With enrichment done (or failed without harm), `run_backup` uploads the generated markdown to `SlackBackup/markdown/` and writes today's date as `last_run_date`. That write is the only thing that moves the incremental window forward. Leaving the `with` block deletes the temp export:

`src/pipeline/backup.py`

```python
        # Upload markdown to Drive
        if drive:
            md_files = list(ingest_dir.glob("*.md"))
            if md_files:
                click.echo(f"Uploading {len(md_files)} markdown file(s) to Drive...")
                drive.upload_directory(ingest_dir, f"{BACKUP_ROOT}/markdown")

        if drive:
            state["last_run_date"] = date.today().isoformat()
            save_backup_state(drive, state)

    click.echo("Done.")
```

The final Drive layout:

    SlackBackup/
    ├── .backup-state.json          {"last_run_date": "..."}            (3.2)
    ├── .enrich-state.json          {note_id: status/warnings/attempts} (4.11)
    ├── exports/YYYY-MM-DD/         raw slackdump output + __uploads/   (3.3)
    ├── markdown/YYYY-MM-DD-<channel>.md                                (3.6)
    └── notes/YYYY-MM/<ts>.json     enriched notes                      (4.10)

## 6. Running enrichment on its own: `pipeline enrich`

The `enrich` command runs the same `run_enrichment` against an export directory that's already on disk. It's for iterating without touching Slack. `--dry-run` only counts what's there, `--out` swaps in `LocalNoteStore` so nothing touches Drive, and `--retry-only` limits the run to notes that already exist. It warms the GPU up front the same way `backup` does:

`src/pipeline/cli.py`

```python
    if dry_run:
        from .parser import parse_channel

        users = load_users(export)
        for channel in sorted(selected):
            channel_dir = export / channel
            if not channel_dir.is_dir():
                click.echo(f"  {channel}: not in this export")
                continue
            messages = parse_channel(channel_dir, users)
            images = sum(1 for m in messages for a in m.attachments
                         if a.filetype in enrich_config.MIME_BY_FILETYPE)
            media = sum(1 for m in messages for a in m.attachments
                        if a.filetype in enrich_config.MEDIA_FILETYPES)
            urls = sum(len(m.urls) for m in messages)
            click.echo(f"  {channel}: {len(messages)} message(s), "
                       f"{images} image(s), {media} audio/video, {urls} link(s)")
        click.echo("[dry-run] no model calls made, nothing written.")
        return
    llm = LLMRouter()
    llm.start_warm()  # boot the GPU while the export is parsed and pages fetched
    try:
        run_enrichment(
            export_dir=export,
            store=store,
            users=load_users(export),
            channels=selected,
            llm=llm,
            limit=limit,
            retry_only=retry_only,
            echo=click.echo,
        )
    finally:
        llm.close()
```

## 7. The older `ingest` command and `state.py`

`pipeline ingest` predates the Drive backup. It converts a local export into an Obsidian-style vault at `~/Desktop/slack-second-brain/ingest/`, with a hard-coded treatment per channel:

* **daily** channels get one file per day (the same `ingest_daily` the backup uses),
* **single-file** channels (a trip-planning channel) get everything in one file with `## day` headings,
* **misc** channels (`random`, `whatever`) are merged into `YYYY-MM-DD-misc.md`, and days with fewer than 3 messages are dropped.

It tracks progress with a local `.pipeline-state.json` holding `last_ingested_ts` (written atomically via a temp file and `replace`), and it's the only caller that uses `write_ingest_file`'s append mode:

`src/pipeline/cli.py` · `src/pipeline/state.py`

```python
DAILY_CHANNELS = {
    "general": "general",
    "fleeting-notes": "fleeting-notes",
    "plans": "plans",
    "media": "media",
    "flash-cards": "flash-cards",
}

SINGLE_FILE_CHANNELS = {
    "trip-planning": "trip-planning",  # renamed for this post
}

MISC_CHANNELS = {"random", "whatever"}
...
def load(vault: Path) -> dict:
    path = vault / STATE_FILE
    if path.exists():
        return json.loads(path.read_text())
    return {"last_ingested_ts": 0.0}


def save(vault: Path, state: dict) -> None:
    path = vault / STATE_FILE
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(path)
```

## 8. Tests

The tests exercise the enrichment stage end to end with the network and the GPU stubbed out. `tests/test_runner.py` builds a minimal slackdump export as a fixture (a screenshot, an article link, a YouTube link and a `channel_join` that should be ignored). `FakeLLM` stands in for `LLMRouter`: it records every batch and replays canned responses, or 503s when `fail=True`. `tests/test_parsing.py` covers the pure helpers (URL extraction, Open Graph, YouTube ids and scraping, article text).

`tests/test_runner.py`

```python
class FakeLLM:
    """Stands in for the router: records calls, replays canned responses."""

    def __init__(self, responses=None, fail=False):
        self.responses = responses or {}
        self.fail = fail
        self.batches = []

    def start_warm(self):
        pass

    def close(self):
        pass

    def map_batch(self, calls):
        self.batches.append(list(calls))
        results = []
        for call in calls:
            if self.fail:
                results.append(CallResult(error="HTTP 503: still booting"))
            elif call.kind == "vision":
                results.append(CallResult(text=json.dumps(
                    {"text": "PYTEST FAILED", "caption": "A terminal window"}
                )))
            else:
                results.append(CallResult(text="It is about batching.\n- Concurrency matters."))
        return results
```

```bash
grep -n '^class \|    def test_' tests/test_runner.py tests/test_parsing.py | sed 's/(self.*//'
```

```text
tests/test_runner.py:69:class FakeLLM:
tests/test_runner.py:128:class TestHappyPath:
tests/test_runner.py:129:    def test_writes_a_note_per_message
tests/test_runner.py:135:    def test_ocr_lands_on_the_attachment
tests/test_runner.py:145:    def test_article_link_is_summarized
tests/test_runner.py:154:    def test_youtube_keeps_channel_and_warns_about_the_missing_summary(
tests/test_runner.py:170:    def test_youtube_costs_no_llm_calls
tests/test_runner.py:177:    def test_all_llm_work_goes_out_in_one_batch
tests/test_runner.py:186:class TestIdempotency:
tests/test_runner.py:187:    def test_second_run_skips_completed_notes
tests/test_runner.py:200:    def test_warned_notes_are_revisited_without_paying_for_llm(
tests/test_runner.py:215:class TestFailureHandling:
tests/test_runner.py:216:    def test_llm_failure_marks_the_note_unprocessed
tests/test_runner.py:225:    def test_unprocessed_notes_are_retried_with_the_llm
tests/test_runner.py:236:    def test_retry_gives_up_after_repeated_failures
tests/test_runner.py:249:    def test_a_dead_link_is_a_soft_failure
tests/test_runner.py:260:    def test_an_unreachable_host_is_retried
tests/test_runner.py:270:class TestThinPages:
tests/test_runner.py:271:    def test_a_page_with_no_article_keeps_metadata_and_skips_the_model(
tests/test_runner.py:289:class TestLimits:
tests/test_runner.py:290:    def test_limit_caps_notes
tests/test_runner.py:295:    def test_retry_only_ignores_new_messages
tests/test_runner.py:301:class TestMerge:
tests/test_runner.py:302:    def test_human_edits_survive_re_enrichment
tests/test_runner.py:317:class TestSummaryReporting:
tests/test_runner.py:318:    def test_warning_reasons_are_itemized
tests/test_runner.py:333:class TestStrippedYouTubePage:
tests/test_runner.py:349:    def test_channel_falls_back_to_oembed
tests/test_runner.py:364:    def test_warns_only_when_oembed_also_fails
tests/test_runner.py:376:class TestVideoIsNotTranscribed:
tests/test_runner.py:397:    def test_mp4_warns_instead_of_spawning
tests/test_runner.py:414:    def test_audio_still_reaches_the_transcriber
tests/test_runner.py:423:class TestRetrySweepStaysFree:
tests/test_runner.py:424:    def test_transcription_is_not_respawned_without_llm_budget
tests/test_parsing.py:7:class TestExtractUrls:
tests/test_parsing.py:8:    def test_labelled_slack_link_keeps_the_url
tests/test_parsing.py:15:    def test_bare_and_bracketed_and_duplicates
tests/test_parsing.py:19:    def test_trailing_punctuation_is_trimmed
tests/test_parsing.py:22:    def test_html_entities_are_decoded
tests/test_parsing.py:28:    def test_no_links
tests/test_parsing.py:32:class TestOpenGraph:
tests/test_parsing.py:43:    def test_reads_both_attribute_orders
tests/test_parsing.py:48:    def test_canonical_and_title_fallback
tests/test_parsing.py:55:    def test_missing_tags_are_none
tests/test_parsing.py:60:class TestYouTubeIds:
tests/test_parsing.py:61:    def test_every_url_shape
tests/test_parsing.py:73:    def test_non_youtube_urls
tests/test_parsing.py:94:class TestYouTubeScraping:
tests/test_parsing.py:95:    def test_ai_summary
tests/test_parsing.py:102:    def test_ai_summary_absent_is_none
tests/test_parsing.py:106:    def test_description_unescapes
tests/test_parsing.py:109:    def test_channel_name_preferred_over_author
tests/test_parsing.py:114:    def test_caption_track_url_is_unescaped
tests/test_parsing.py:119:class TestArticleText:
tests/test_parsing.py:120:    def test_strips_chrome_and_collapses_whitespace
tests/test_parsing.py:131:    def test_respects_cap
```

```bash
uv run --group dev pytest -q 2>&1 | tail -1 | sed -E 's/ in [0-9.]+s//'
```

```text
40 passed
```

There are no tests for the backup path (`backup.py`, `gdrive.py`, `channels.py`, `vault.py`), and none for warning expiry (see the note at the end of 4.10).

## 9. Side project: `digital-garden-canvas/`

This is a separate Vite + React + Excalidraw prototype that shares no code with the pipeline. It shows an Excalidraw canvas next to a sidebar "queue" of websites. You drag a site onto the canvas (or click it), and it becomes a grouped Excalidraw box. The snippets below come from the committed version. Work in progress since then extracts `queue.ts`, adds a `placing` guard against double-adds, and adds Vitest/Playwright tests.

The key idea is that **the queue isn't stored anywhere**. Every element of a card carries `customData.siteId`, and the queue is just "every site with no live element on the canvas". Deleting a box or undoing a drop therefore puts the site back in the queue for free:

`digital-garden-canvas/src/App.tsx`

```tsx
/** Ids of sites that currently have a (non-deleted) box on the canvas. */
function placedSiteIds(elements: readonly OrderedExcalidrawElement[]) {
  const ids = new Set<string>();
  for (const el of elements) {
    const siteId = el.customData?.siteId;
    if (!el.isDeleted && typeof siteId === "string") ids.add(siteId);
  }
  return ids;
}

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [docked, setDocked] = useState(true);
  // The queue is every site without a box on the canvas, so deleting a box
  // (or undoing a drop) puts the site back in the queue.
  const [placed, setPlaced] = useState<Set<string>>(new Set());
  const placedKey = useRef("");
  const queue = SITES.filter(s => !placed.has(s.id));

  // Start fetching pictures early so drops feel instant.
  useEffect(() => { SITES.forEach(loadSiteImage); }, []);

  const onChange = useCallback((elements: readonly OrderedExcalidrawElement[]) => {
    const ids = placedSiteIds(elements);
    const key = [...ids].sort().join("|");
    if (key !== placedKey.current) {
      placedKey.current = key;
      setPlaced(ids);
    }
  }, []);
```

Placing a site waits for its picture and for the fonts its text needs. Excalidraw measures text when the element is created, so measuring against a fallback font would clip the text. It then converts the drop point from viewport to scene coordinates and appends the card's elements as one undoable step:

`digital-garden-canvas/src/App.tsx`

```tsx
  const placeSite = useCallback(async (site: Site, clientX: number, clientY: number) => {
    if (!api) return;
    const [image] = await Promise.all([loadSiteImage(site), loadCardFonts(site)]);
    const { x, y } = viewportCoordsToSceneCoords({ clientX, clientY }, api.getAppState());
    if (image) api.addFiles([image.file]);
    const index = SITES.findIndex(s => s.id === site.id);
    const elements = buildSiteElements(site, index, x - CARD_WIDTH / 2, y - 24, image);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, [api]);
```

`siteCard.buildSiteElements` lays the card out top to bottom with a `cursor` (optional image scaled to at most 150px tall, the name in Excalifont, the host, an optional wrapped description), then sizes a rounded rectangle to fit. The rectangle goes first in the element list so it renders underneath, and it carries the site URL as its Excalidraw `link`:

`digital-garden-canvas/src/siteCard.ts`

```ts
export function buildSiteElements(site: Site, index: number, x: number, y: number, image: LoadedImage | null) {
  const groupId = `site-group-${site.id}-${Date.now()}`;
  const common = { groupIds: [groupId], customData: { siteId: site.id } };
  const children: Parameters<typeof convertToExcalidrawElements>[0] = [];

  let cursor = y + PAD;

  const box = {
    ...common,
    type: "rectangle" as const,
    x,
    y,
    width: CARD_WIDTH,
    height: cursor + PAD - y,
    backgroundColor: FILLS[index % FILLS.length],
    fillStyle: "solid" as const,
    roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
    link: site.url,
  };

  // Box first so it sits underneath its contents.
  return convertToExcalidrawElements([box, ...children]);
}
```

`SiteQueue.tsx` implements drag-and-drop by hand with pointer events instead of HTML5 DnD, because the drop target is Excalidraw's `<canvas>`. A 4px threshold separates a click (→ `onPick`, placed mid-viewport) from a drag. A portal-rendered "ghost" follows the pointer, and on release `document.elementFromPoint` checks that the pointer is over the Excalidraw canvas and not over a toolbar:

`digital-garden-canvas/src/SiteQueue.tsx`

```tsx
/** True when the viewport point is over Excalidraw's drawing surface, not
 *  over its toolbars, menus or this sidebar. */
function isOverCanvas(clientX: number, clientY: number) {
  const el = document.elementFromPoint(clientX, clientY);
  return el instanceof HTMLCanvasElement && !!el.closest(".excalidraw");
}
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
    d.active = true;
    setGhost({ site: d.site, x: e.clientX - d.offX, y: e.clientY - d.offY, width: d.width });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setGhost(null);
    if (!d) return;
    if (!d.active) onPick(d.site);
    else if (isOverCanvas(e.clientX, e.clientY)) onDrop(d.site, e.clientX, e.clientY);
  };
```

## Recap

1. **Cron** (06:00 UTC) → restore slackdump creds → `pipeline backup --enrich`.
2. **Start GPU warm-up** on a background thread right away.
3. **Export** incrementally (last run − 3 days) with slackdump into a temp dir.
4. **Mirror** the raw export to Drive and build `slack_file_id → Drive URL`.
5. **Parse** each channel into `Message`s (URLs extracted before cleaning) and write **daily markdown** with threads grouped and attachments linked to Drive.
6. **Enrich** `#fleeting-notes` and `#media`: plan per note from the state index → *gather* (scrape, preprocess, spawn transcriptions) → one 16-wide **LLM burst** → *finish*, then **merge** losslessly with existing notes → write JSON notes plus the state index.
7. **Upload** the markdown, record `last_run_date`, and let the temp dir vanish.

The design is shaped by two things. Cost: wake one GPU once, overlap its boot with I/O, and keep it saturated. Resilience: best-effort processors, a soft/hard failure split, lossless merges, and enrichment that can never break the backup.

