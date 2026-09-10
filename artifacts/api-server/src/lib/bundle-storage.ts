import { Storage } from "@google-cloud/storage";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

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
  const relativePath = `rewind/bundles/${branchId}/${commitHash}.bundle`;
  const { bucketName, objectName } = privateLocation(relativePath);
  const destination = storage.bucket(bucketName).file(objectName);
  await pipeline(createReadStream(localPath), destination.createWriteStream({
    resumable: false,
    metadata: {
      contentType: "application/x-git-bundle",
      cacheControl: "private, no-store",
      metadata: { branchId, commitHash },
    },
  }), { signal });
  return `/objects/${relativePath}`;
}

export async function downloadBundle(objectKey: string, destination: string, signal?: AbortSignal) {
  const { bucketName, objectName } = locationFromObjectKey(objectKey);
  await pipeline(
    storage.bucket(bucketName).file(objectName).createReadStream(),
    createWriteStream(destination),
    { signal },
  );
}