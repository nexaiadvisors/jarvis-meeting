// Phase 2 — audio artifact -> Azure Blob + SAS URL.
//
// On meeting end: fetch the Recall bot record, extract the mixed-audio download
// URL from recordings[].media_shortcuts.audio_mixed.data.download_url, stream-
// copy it into Azure Blob Storage, then mint a read-only SAS token.
//
// Config-gating: if Azure Storage env vars are absent, logs a structured warn
// and returns null.  Real failures (non-2xx fetch, blob put error) throw/log loudly.
//
// The Recall signed audio URL is valid for ~5 hours; callers MUST NOT cache it.

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { Readable } from 'node:stream';
import type { Config } from '../config.js';

export interface ArtifactResult {
  blobUrl: string;
  sasUrl: string;
  expiresAt: string;
}

// Shape of the Recall GET /bot/{botId}/ response (subset we care about).
interface RecallMediaDownload {
  download_url?: string | null;
}
interface RecallMediaShortcut {
  data?: RecallMediaDownload | null;
}
interface RecallMediaShortcuts {
  audio_mixed?: RecallMediaShortcut | null;
}
interface RecallRecording {
  media_shortcuts?: RecallMediaShortcuts | null;
}
interface RecallBotResponse {
  id: string;
  recordings?: RecallRecording[] | null;
}

function isAzureConfigured(config: Config): boolean {
  return Boolean(
    config.azureStorageAccountName &&
      config.azureStorageAccountKey &&
      config.azureStorageBlobContainer,
  );
}

export async function uploadAudioArtifact(
  config: Config,
  botId: string,
  meetingId: string,
): Promise<ArtifactResult | null> {
  if (!isAzureConfigured(config)) {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'artifacts: AZURE_STORAGE not configured, skipping',
        botId,
        meetingId,
      }),
    );
    return null;
  }

  // 1. Retrieve bot from Recall — do NOT cache the signed URL.
  const botResp = await fetch(`${config.recallApiBase}/bot/${botId}/`, {
    headers: {
      Authorization: `Token ${config.recallApiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!botResp.ok) {
    const body = await botResp.text().catch(() => '');
    throw new Error(
      `artifacts: Recall GET /bot/${botId}/ failed (${botResp.status}): ${body.slice(0, 200)}`,
    );
  }
  const bot = (await botResp.json()) as RecallBotResponse;

  const downloadUrl = bot.recordings?.[0]?.media_shortcuts?.audio_mixed?.data?.download_url;
  if (!downloadUrl) {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'artifacts: no audio_mixed download_url on bot — skipping',
        botId,
        meetingId,
      }),
    );
    return null;
  }

  // 2. Stream audio from Recall into Azure Blob.
  const audioResp = await fetch(downloadUrl);
  if (!audioResp.ok) {
    throw new Error(
      `artifacts: Recall audio download failed (${audioResp.status}) for bot ${botId}`,
    );
  }

  // Infer extension from Content-Type; default to .mp4 (Recall's common format).
  const contentType = audioResp.headers.get('content-type') ?? 'audio/mp4';
  const ext = contentType.includes('webm') ? 'webm' : contentType.includes('ogg') ? 'ogg' : 'mp4';
  const blobName = `meetings/${meetingId}/audio/${botId}.${ext}`;

  const sharedKeyCredential = new StorageSharedKeyCredential(
    config.azureStorageAccountName!,
    config.azureStorageAccountKey!,
  );
  const blobServiceClient = new BlobServiceClient(
    `https://${config.azureStorageAccountName}.blob.core.windows.net`,
    sharedKeyCredential,
  );
  const containerClient = blobServiceClient.getContainerClient(
    config.azureStorageBlobContainer!,
  );
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  if (!audioResp.body) {
    throw new Error(`artifacts: Recall audio response has no body for bot ${botId}`);
  }

  // @azure/storage-blob uploadStream requires a Node.js Readable.
  // Convert the fetch() web ReadableStream via Readable.fromWeb().
  const nodeStream = Readable.fromWeb(
    audioResp.body as import('stream/web').ReadableStream<Uint8Array>,
  );
  await blockBlobClient.uploadStream(
    nodeStream,
    undefined,
    undefined,
    { blobHTTPHeaders: { blobContentType: contentType } },
  );

  const blobUrl = blockBlobClient.url;

  // 3. Mint a read-only SAS token.
  const ttlHours = config.artifactSasTtlHours;
  const expiresOn = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: config.azureStorageBlobContainer!,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn,
    },
    sharedKeyCredential,
  ).toString();

  const sasUrl = `${blobUrl}?${sasToken}`;

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'artifacts: audio uploaded',
      botId,
      meetingId,
      blobName,
      sasExpires: expiresOn.toISOString(),
    }),
  );

  return { blobUrl, sasUrl, expiresAt: expiresOn.toISOString() };
}
