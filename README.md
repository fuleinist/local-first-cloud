# local-first-cloud ☁️🏠

**Your own S3-compatible cloud that lives on your machine.**

local-first-cloud runs a real S3 endpoint on localhost, backed by the plain
local filesystem, with AWS SigV4 auth — so `aws s3` CLI, boto3, the AWS SDKs
and any S3-speaking tool work against it unmodified. Plus one-command
**encrypted backup** (AES-256-GCM) to a single portable file you can sync
anywhere: Drive, Backblaze, rclone, a USB stick in a drawer.

Zero runtime dependencies. Node.js >= 18. That's it.

```
┌──────────────┐   S3 API (SigV4)   ┌────────────────────┐
│ aws cli/boto │ ─────────────────► │  lfc start (:9100) │
└──────────────┘                    │  buckets/  meta/   │──► your disk
                                    └─────────┬──────────┘
                                              │ lfc backup
                                              ▼
                                    vault.lfcb (AES-256-GCM)
```

## Quick start

```bash
npm install -g local-first-cloud   # or: git clone && npm link

lfc init --gen-keys                # config + random access keys
lfc start                          # S3 server on 127.0.0.1:9100
```

Point any S3 tool at it:

```bash
aws --endpoint-url http://127.0.0.1:9100 s3 mb s3://photos
aws --endpoint-url http://127.0.0.1:9100 s3 cp ./dog.jpg s3://photos/dog.jpg
aws --endpoint-url http://127.0.0.1:9100 s3 ls s3://photos
```

(using the access key/secret printed by `lfc init`, region `us-east-1`)

Or use the built-in client:

```bash
lfc mb s3://photos
lfc put ./dog.jpg s3://photos/dog.jpg
lfc ls s3://photos --long
lfc get s3://photos/dog.jpg ./restored.jpg
lfc rm s3://photos/dog.jpg
```

## Encrypted backup / restore

```bash
lfc backup vault.lfcb --passphrase "correct horse battery staple"
# copy vault.lfcb anywhere (rclone, Drive, USB...)

lfc restore vault.lfcb --data-dir /new/machine/data
```

- Key: scrypt(passphrase), cipher: AES-256-GCM, fresh IV per file, auth tag
  verified on restore — a wrong passphrase or tampered archive restores
  **nothing**.
- Archives are plain sequential files; the format is documented in
  [SPEC.md](SPEC.md) so you're never locked in.

## What's supported

Buckets: create / head / delete (when empty) / list. Objects: put / get /
head / copy / delete / batch-delete, list v1+v2 with prefix, delimiter,
paging. Content-Type + `x-amz-meta-*` user metadata. SigV4 header auth with
skew protection, or anonymous mode for trusted LANs.

Not yet (clean `501 NotImplemented`): multipart upload, presigned URLs,
versioning, Range GET, chunked streaming signatures. See [SPEC.md](SPEC.md).

## Configuration

Precedence: CLI flags > env > `~/.local-first-cloud/config.json` > defaults.

| Env | Default | Meaning |
|---|---|---|
| `LFC_DATA_DIR` | `~/.local-first-cloud/data` | where buckets live |
| `LFC_ENDPOINT` | `http://127.0.0.1:9100` | client target |
| `LFC_ACCESS_KEY_ID` / `LFC_SECRET_ACCESS_KEY` | — | credentials |
| `LFC_REGION` | `us-east-1` | signing region |
| `LFC_PASSPHRASE` | — | backup/restore passphrase |

## Storage layout

Objects are **plain files** — no database, no proprietary blob store:

```
<dataDir>/buckets/<bucket>/<key>        # your bytes, untouched
<dataDir>/meta/<bucket>/<key>.json      # contentType, etag, userMeta...
```

You can `cp`, `rsync`, Time Machine or `grep` your "cloud" directly. Deleting
lfc never orphans your data.

## Development

```bash
npm test        # node:test suite (sigv4, store, xml, backup, server, cli)
```

CI: GitHub Actions, ubuntu + windows × Node 18/20/22.

## License

MIT
