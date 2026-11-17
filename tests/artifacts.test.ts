import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../src/config.js';

// ------------------------------------------------------------------
// Mock @azure/storage-blob before importing the module under test.
// ------------------------------------------------------------------
const mockUploadStream = vi.fn(async () => ({}));
const mockBlockBlobClient = {
  uploadStream: mockUploadStream,
  url: 'https://account.blob.core.windows.net/container/meetings/mtg1/audio/bot1.mp4',
};
const mockContainerClient = {
  getBlockBlobClient: vi.fn(() => mockBlockBlobClient),
};
const mockBlobServiceClient = {
  getContainerClient: vi.fn(() => mockContainerClient),
};

vi.mock('@azure/storage-blob', () => {
  function MockBlobServiceClient() { return mockBlobServiceClient; }
  function MockStorageSharedKeyCredential() { return {}; }
  return {
    BlobServiceClient: MockBlobServiceClient,
    StorageSharedKeyCredential: MockStorageSharedKeyCredential,
    BlobSASPermissions: { parse: vi.fn(() => ({})) },
    generateBlobSASQueryParameters: vi.fn(() => ({ toString: () => 'sig=fake&se=fake' })),
  };
});

const { uploadAudioArtifact } = await import('../src/postmeeting/artifacts.js');

const FULL_CONFIG: Config = {
  port: 8787,
  recallApiKey: 'rk',
  recallApiBase: 'https://us-east-1.recall.ai/api/v1',
  maxConcurrentPerTeammate: 2,
  idleTimeoutMs: 600000,
  maxDurationMs: 7200000,
  sweepIntervalMs: 60000,
  publicBaseUrl: 'https://ngrok.example.com',
  teamKbAnswerEndpoint: undefined,
  teamKbAnswerApiToken: undefined,
  teamKbFallbackUrl: 'http://localhost:3031',
  jarvisBotName: 'Jarvis',
  jarvisApiToken: undefined,
  webhookSecret: undefined,
  azureStorageAccountName: 'myaccount',
  azureStorageAccountKey: 'mykey',
  azureStorageBlobContainer: 'meetings',
  artifactSasTtlHours: 168,
  anthropicApiKey: undefined,
  anthropicModel: 'claude-sonnet-4-6',
  graphTenantId: undefined,
  graphClientId: undefined,
  graphClientSecret: undefined,
  meetingEmailSender: undefined,
  meetingEmailDefaultRecipients: [],
};

const NO_AZURE_CONFIG: Config = {
  ...FULL_CONFIG,
  azureStorageAccountName: undefined,
  azureStorageAccountKey: undefined,
  azureStorageBlobContainer: undefined,
};

const FAKE_BOT_RESPONSE = {
  id: 'bot1',
  recordings: [
    {
      media_shortcuts: {
        audio_mixed: {
          data: { download_url: 'https://recall-cdn.example.com/audio/bot1.mp4' },
        },
      },
    },
  ],
};

function mockAudioStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploadAudioArtifact', () => {
  it('returns null and logs warn when Azure is not configured', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await uploadAudioArtifact(NO_AZURE_CONFIG, 'bot1', 'mtg1');
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('AZURE_STORAGE not configured'),
    );
  });

  it('fetches the Recall bot record then the audio download URL', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('/bot/')) {
        return new Response(JSON.stringify(FAKE_BOT_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Audio download
      return new Response(mockAudioStream(), {
        status: 200,
        headers: { 'Content-Type': 'audio/mp4', 'content-length': '3' },
      });
    });

    await uploadAudioArtifact(FULL_CONFIG, 'bot1', 'mtg1');
    expect(calls[0]).toBe('https://us-east-1.recall.ai/api/v1/bot/bot1/');
    expect(calls[1]).toBe('https://recall-cdn.example.com/audio/bot1.mp4');
  });

  it('calls blob uploadStream', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/bot/')) {
        return new Response(JSON.stringify(FAKE_BOT_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(mockAudioStream(), {
        status: 200,
        headers: { 'Content-Type': 'audio/mp4' },
      });
    });

    await uploadAudioArtifact(FULL_CONFIG, 'bot1', 'mtg1');
    expect(mockUploadStream).toHaveBeenCalledOnce();
  });

  it('returns sasUrl and expiresAt on success', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/bot/')) {
        return new Response(JSON.stringify(FAKE_BOT_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(mockAudioStream(), {
        status: 200,
        headers: { 'Content-Type': 'audio/mp4' },
      });
    });

    const result = await uploadAudioArtifact(FULL_CONFIG, 'bot1', 'mtg1');
    expect(result).not.toBeNull();
    expect(result?.sasUrl).toContain('sig=fake');
    expect(result?.expiresAt).toBeTruthy();
  });

  it('returns null (and logs warn) when bot has no audio_mixed download_url', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'bot1', recordings: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await uploadAudioArtifact(FULL_CONFIG, 'bot1', 'mtg1');
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('no audio_mixed download_url'),
    );
  });

  it('throws on non-2xx Recall bot fetch', async () => {
    global.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    await expect(uploadAudioArtifact(FULL_CONFIG, 'bot1', 'mtg1')).rejects.toThrow('401');
  });
});
