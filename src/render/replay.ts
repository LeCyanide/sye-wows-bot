/**
 * The parts of /render that do not need Discord: what counts as a replay,
 * fetching one with a size cap, one render at a time, and what a failure
 * says to the channel.
 */

import { RenderError, supportedVersions } from './wows-render.ts';

/** Replays are almost never over 5 MB; anything past this is refused unread. */
export const MAX_REPLAY_BYTES = 10 * 1024 * 1024;

export const REPLAY_EXTENSION = '.wowsreplay';

/** Why an attachment is refused before it is fetched, or null when it may be. */
export function refuseAttachment(name: string, size: number): string | null {
  if (!name.toLowerCase().endsWith(REPLAY_EXTENSION)) {
    return `That is not a replay: attach a \`${REPLAY_EXTENSION}\` file from the game's \`replays\` folder.`;
  }
  if (size > MAX_REPLAY_BYTES) {
    return `That replay is ${(size / 1024 / 1024).toFixed(1)} MB; I take up to ${MAX_REPLAY_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/** `Some_battle.wowsreplay` → `Some_battle.mp4`, with nothing a file name should not hold. */
export function videoName(replayName: string): string {
  const stem = replayName.slice(0, replayName.length - REPLAY_EXTENSION.length);
  const safe = stem.replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 100);
  return `${safe || 'replay'}.mp4`;
}

export class DownloadError extends Error {}

/**
 * Fetches the attachment, giving up past `maxBytes` whatever the size Discord
 * reported, so a wrong size cannot make the bot read an unbounded body.
 */
export async function downloadReplay(url: string, maxBytes = MAX_REPLAY_BYTES, timeoutMs = 30_000): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new DownloadError(`fetching the attachment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || response.body === null) {
    throw new DownloadError(`fetching the attachment failed with HTTP ${response.status}`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new DownloadError(`the attachment is over ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(`reading the attachment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.concat(chunks);
}

/** `15_10_0` → `15.10.0`. */
export function formatVersion(key: string): string {
  return key.replaceAll('_', '.');
}

/**
 * What the channel is told when a render fails. The CLI's own message can
 * name paths on the server, so only the game version is taken from it.
 */
export async function failureMessage(error: unknown, dataDir: string): Promise<string> {
  if (!(error instanceof RenderError)) return 'Rendering failed on my side.';

  switch (error.code) {
    case 'unsupported_version': {
      const version = /game version (\S+(?: \(build \d+\))?)/.exec(error.message)?.[1];
      let have = '';
      try {
        const versions = await supportedVersions(dataDir);
        have = versions.length > 0 ? ` I can render ${versions.map(formatVersion).join(', ')}.` : '';
      } catch {
        // The list is a courtesy; the refusal stands without it.
      }
      return `This replay is from a game version I cannot render yet${version ? ` (${version})` : ''}.${have}`;
    }
    case 'bad_replay':
      return 'That file does not look like a valid World of Warships replay.';
    case 'too_large':
      return 'This battle does not fit in a video under the upload limit.';
    case 'timeout':
      return 'Rendering took too long and was stopped.';
    default:
      return 'Rendering failed on my side.';
  }
}

export class QueueFullError extends Error {}
export class AlreadyQueuedError extends Error {}

/**
 * Runs renders one or two at a time: each takes 4–14 s and about two cores,
 * usually on a small VPS that does other work too. A member gets one render in
 * line at a time, and the line has a length limit, so that a long wait cannot
 * outlast Discord's 15-minute interaction window.
 */
export class RenderQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly users = new Set<string>();

  readonly concurrency: number;
  readonly maxWaiting: number;

  constructor(concurrency: number, maxWaiting: number) {
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
  }

  /**
   * Runs `job` once a slot is free. Throws QueueFullError or
   * AlreadyQueuedError at once, before anything is queued.
   * `onWait` is told the position when the job has to wait.
   */
  async run<T>(user: string, job: () => Promise<T>, onWait?: (position: number) => void): Promise<T> {
    if (this.users.has(user)) throw new AlreadyQueuedError('one render per member at a time');
    const mustWait = this.running >= this.concurrency;
    if (mustWait && this.waiting.length >= this.maxWaiting) throw new QueueFullError('the render queue is full');

    this.users.add(user);
    try {
      if (mustWait) {
        const position = this.waiting.length + 1;
        const turn = new Promise<void>((resolve) => this.waiting.push(resolve));
        try {
          onWait?.(position);
        } catch {
          // A failed status message must not lose the job its place.
        }
        await turn; // the finishing job hands its slot over, so `running` stays counted
      } else {
        this.running += 1;
      }
      try {
        return await job();
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.running -= 1;
      }
    } finally {
      this.users.delete(user);
    }
  }
}
