import { Storage } from "@google-cloud/storage";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { BUNDLE_UPLOAD_TIMEOUT_MS, registerBundleUpload } from "./bundle-upload-intents";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function privateLocation(relativePath: string) {
  const privateDir = process.env["PRIVATE_OBJECT_DIR"];
  if (!privateDir) throw new Error("App Storage is not configured.");
  const parts = privateDir.replace(/^\/+/, "").split("/");
  const bucketName = parts.shift();
  if (!bucketName) throw new Error("PRIVATE_OBJECT_DIR is invalid.");
  const prefix = parts.join("/").replace(/\/+$/, "");
  return {
    bucketName,
    objectName: [prefix, relativePath.replace(/^\/+/, "")].filter(Boolean).join("/"),
  };
}

function locationFromObjectKey(objectKey: string) {
  if (!objectKey.startsWith("/objects/")) throw new Error("Invalid bundle object key.");
  return privateLocation(objectKey.slice("/objects/".length));
}

export async function uploadBundle(localPath: string, branchId: string, commitHash: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Immutable per-attempt keys prevent a cancelled repeat checkpoint from
  // overwriting or deleting an earlier checkpoint of the very same commit.
  const relativePath = `rewind/bundles/${branchId}/${commitHash}/${randomUUID()}.bundle`;
  const objectKey = `/objects/${relativePath}`;
  const uploadSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(BUNDLE_UPLOAD_TIMEOUT_MS),
  ]);
  // Never touch storage before this durable write. On *any* failure leave the
  // intent intact; even abort can race successful object creation.
  await registerBundleUpload(objectKey);
  uploadSignal.throwIfAborted();
  const localRoot = process.env["REWIND_LOCAL_BUNDLE_DIR"];
  if (localRoot) {
    const destination = path.join(localRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    uploadSignal.throwIfAborted();
    await pipeline(createReadStream(localPath), createWriteStream(destination, { flags: "wx" }), { signal: uploadSignal });
    uploadSignal.throwIfAborted();
    return objectKey;
  }
  const { bucketName, objectName } = privateLocation(relativePath);
  const destination = storage.bucket(bucketName).file(objectName);
  await pipeline(createReadStream(localPath), destination.createWriteStream({
    resumable: false,
    metadata: {
      contentType: "application/x-git-bundle",
      cacheControl: "private, no-store",
      metadata: { branchId, commitHash },
    },
  }), { signal: uploadSignal });
  uploadSignal.throwIfAborted();
  return objectKey;
}

export async function downloadBundle(objectKey: string, destination: string, signal?: AbortSignal) {
  const localRoot = process.env["REWIND_LOCAL_BUNDLE_DIR"];
  if (localRoot) {
    if (!objectKey.startsWith("/objects/")) throw new Error("Invalid bundle object key.");
    signal?.throwIfAborted();
    await copyFile(path.join(localRoot, objectKey.slice("/objects/".length)), destination);
    signal?.throwIfAborted();
    return;
  }
  const { bucketName, objectName } = locationFromObjectKey(objectKey);
  await pipeline(
    storage.bucket(bucketName).file(objectName).createReadStream(),
    createWriteStream(destination),
    { signal },
  );
}

export async function deleteBundle(objectKey: string) {
  const localRoot = process.env["REWIND_LOCAL_BUNDLE_DIR"];
  if (localRoot) {
    const { rm } = await import("node:fs/promises");
    if (!objectKey.startsWith("/objects/")) throw new Error("Invalid bundle object key.");
    await rm(path.join(localRoot, objectKey.slice("/objects/".length)), { force: true });
    return;
  }
  const { bucketName, objectName } = locationFromObjectKey(objectKey);
  await storage.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
}