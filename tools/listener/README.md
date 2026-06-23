# 🎙️ The Tsong Ear

Ambient idea capture. A mic listens to the room; when someone proposes a feature for Tsong,
it specs the idea and (with your approval) hands it to Claude Code to implement.

```
transcript → Gate-1 (cheap Haiku: "is this a Tsong idea?")
           → Gate-2 (spec it) → approval → `claude -p` implements + commits
```

## Requirements

- The `claude` CLI on your PATH (Claude Code), authenticated.
- A speech-to-text source — either local whisper.cpp (recommended) or any STT piped to stdin.

## Quick start (test it with no mic)

```sh
echo "hey tsong, what if the ball left a rainbow trail" | npx tsx tools/listener/listen.ts --dry-run
```

You should see it arm on the wake phrase, detect the idea, and print it without writing code.

## Real listening with local whisper.cpp (private, free)

One-time build:

```sh
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
sh ./models/download-ggml-model.sh base.en
make stream            # builds the streaming binary
```

Then run the Ear, pointing it at that binary:

```sh
WHISPER_STREAM=/path/to/whisper.cpp/stream \
WHISPER_MODEL=/path/to/whisper.cpp/models/ggml-base.en.bin \
  npm run listen -- --dry-run
```

Drop `--dry-run` when you trust it. It will ask before implementing unless you pass `--yes`.

## Bring your own STT

Anything that prints transcript lines works — just pipe it in:

```sh
your-stt-command | npm run listen
```

## Flags

| Flag             | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `--dry-run`      | Detect + print ideas, never write code. Use this first.            |
| `--no-wake`      | Fully ambient (default requires the wake phrase to arm capture).   |
| `--wake "…"`     | Set the wake phrase (default: `hey tsong`).                        |
| `--yes`          | Auto-approve implementation (full chaos). Otherwise it asks.       |
| `--push`         | Let the implement step push to the remote (default: commit only).  |

## Safety / consent

An always-on mic capturing other people's conversation is regulated in many places
(several US states require all-party consent to record). The defaults are deliberately
conservative: a wake phrase doubles as consent, nothing is implemented without a `y`,
and changes are committed locally — not pushed — unless you pass `--push`. Raw audio is
never stored; only short transcript windows live in memory.
