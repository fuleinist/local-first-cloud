# local-first-cloud — SPEC

**Tagline:** Your own S3-compatible API that stores files locally, with encrypted backup to anywhere.

## Problem

Privacy-conscious devs and indie hackers want cloud-storage *convenience* (the S3 API — every tool already speaks it) without cloud *dependency* (cost, egress fees, third-party custody). local-first-cloud runs a real S3-compatible endpoint on your machine, backed by the local filesystem, and can produce a single encrypted archive you can sync to any provider (Drive, Backblaze, rclone, USB stick).

## Goals (v0.1.0)

1. **S3-compatible HTTP server** (subset) that `aws s3` CLI and S3 SDKs can talk to.
2. **Local filesystem backend** — buckets are directories, objects are plain files + JSON sidecar metadata.
3. **AWS SigV4 authentication** (header-based) when access keys are configured; anonymous mode when not.
4. **CLI client** (`lfc`) for init/start/put/get/ls/rm/mb/rb/status.
5. **Encrypted backup/restore** — AES-256-GCM, scrypt-derived key from a passphrase, single portable archive file.
6. **Zero runtime dependencies** — Node.js >= 18 only (`node:http`, `node:crypto`, `node:fs`).
7. **Test suite** (`node:test`) covering sigv4, store, xml, backup, and full server integration.
8. **CI** — GitHub Actions, ubuntu + windows × Node 18/20/22.

## Supported S3 operations

| Operation | Method / Path | Notes |
|---|---|---|
| ListBuckets | `GET /` | |
| CreateBucket | `PUT /{bucket}` | |
| HeadBucket | `HEAD /{bucket}` | returns `x-amz-bucket-region` |
| DeleteBucket | `DELETE /{bucket}` | only when empty (S3 semantics) |
| ListObjectsV2 | `GET /{bucket}?list-type=2` | prefix, delimiter, max-keys, continuation tokens |
| ListObjects (v1) | `GET /{bucket}` | marker-based |
| GetBucketAcl | `GET /{bucket}?acl` | canned response |
| PutObject | `PUT /{bucket}/{key}` | Content-Type, `x-amz-meta-*` user metadata |
| CopyObject | `PUT /{bucket}/{key}` + `x-amz-copy-source` | |
| GetObject | `GET /{bucket}/{key}` | streamed; ETag, Last-Modified, metadata headers |
| HeadObject | `HEAD /{bucket}/{key}` | |
| DeleteObject | `DELETE /{bucket}/{key}` | always 204 (S3 semantics) |
| DeleteObjects | `POST /{bucket}?delete` | batch XML |
| Health | `GET /?lfc-health` | unauthenticated JSON |

**Out of scope for v0.1.0 (returns 501 NotImplemented):** multipart upload, presigned URLs, versioning, object ACLs, bucket policies, SSE-C/SSE-KMS (backup archive encryption is separate), chunked `aws-chunked` streaming signatures, Range GET.

## Authentication

- If `accessKeyId`/`secretAccessKey` are configured → every request (except health) must carry a valid `AWS4-HMAC-SHA256` Authorization header. Signed headers must include `host` and `x-amz-date`; payload verified via `x-amz-content-sha256` (literal hash or `UNSIGNED-PAYLOAD`; `STREAMING-*` rejected).
- Clock skew tolerance: ±15 minutes (`RequestTimeTooSkewed`).
- Bad signature → 403 `SignatureDoesNotMatch`; missing header → 403 `AccessDenied`.
- No keys configured → anonymous mode (personal LAN use; server warns loudly on start).

## Storage layout

```
<dataDir>/
  buckets/<bucket>/<key...>        # raw object bytes (plain files)
  meta/<bucket>/<key...>.json      # {contentType, etag, size, userMeta, createdAt}
```

- ETag = MD5 hex of content (matches S3 for non-multipart objects).
- Key validation: reject `..` segments, empty segments, backslashes, absolute paths, keys > 1024 bytes. Bucket names: S3 rules (3–63 chars, lowercase letters/digits/hyphens/dots, no leading/trailing hyphen).
- All paths resolved and contained within `<dataDir>` (traversal-proof).

## Backup archive format (`.lfcb`)

```
"LFCK" magic | u32 headerLen | JSON header
  header: {v:1, kdf:{name:"scrypt",N:16384,r:8,p:1,salt:hex}, cipher:"aes-256-gcm", createdAt, node:"<hostname>"}
then repeated entries:
  u32 pathLen | path utf8 | u64 size | 12B IV | ciphertext | 16B GCM tag
terminator: u32 pathLen == 0
```

- Key = scrypt(passphrase, salt, 32). One random IV per entry. GCM tag verified on restore; wrong passphrase → auth failure, nothing written.
- `lfc backup <file> --passphrase P` (or `LFC_PASSPHRASE` env) and `lfc restore <file> [--data-dir D]`.

## CLI

```
lfc init [--data-dir D] [--port P] [--gen-keys]     # write ~/.local-first-cloud/config.json
lfc start [--host H] [--port P] [--data-dir D]      # run the S3 server
lfc status                                          # health check against configured endpoint
lfc mb s3://bucket | lfc rb s3://bucket [--force]
lfc put <file> s3://bucket/key [--content-type T]
lfc get s3://bucket/key [file]
lfc ls [s3://bucket[/prefix]] [--long]
lfc rm s3://bucket/key [--recursive]
lfc backup <outfile> [--passphrase P]
lfc restore <infile> [--data-dir D] [--passphrase P]
```

Config precedence: CLI flags > env (`LFC_DATA_DIR`, `LFC_ENDPOINT`, `LFC_ACCESS_KEY_ID`, `LFC_SECRET_ACCESS_KEY`, `LFC_REGION`, `LFC_PASSPHRASE`) > config file > defaults (dataDir `~/.local-first-cloud/data`, host `127.0.0.1`, port `9100`, region `us-east-1`).

## Acceptance criteria

1. `npm test` passes on Node 18/20/22, ubuntu + windows.
2. With keys configured, signed requests via `aws s3`-style SigV4 succeed end-to-end: mb → put → ls → get (byte-identical) → copy → head → rm → rb.
3. Tampered signature, wrong secret, and >15-min-skewed dates are rejected with 403.
4. Anonymous mode works when no keys configured.
5. Path traversal attempts (`../`, encoded variants, absolute keys) are rejected 400 and never touch the filesystem outside `<dataDir>`.
6. DeleteBucket on a non-empty bucket → 409 BucketNotEmpty.
7. ListObjectsV2 honors prefix/delimiter/max-keys; continuation token round-trips; CommonPrefixes correct.
8. Backup → wipe dataDir → restore reproduces all objects byte-identically; wrong passphrase fails without partial restore.
9. `lfc` smoke: start server on ephemeral port, `lfc mb/put/ls/get/rm/status` all succeed against it.
10. No `process.exit()` with open handles on Windows (use `process.exitCode`); server closes cleanly on SIGINT/SIGTERM.
11. Unsupported operations return well-formed S3 XML errors with code `NotImplemented` and HTTP 501.
