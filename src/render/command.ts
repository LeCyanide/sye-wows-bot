/**
 * /render: a member attaches a replay and the bot answers in the channel with
 * a video of the minimap and the battle panel, made by replay-parser's
 * wows-render. Registered only when WOWS_RENDER_BIN and WOWS_DATA_DIR are set.
 */

import {
  AttachmentBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { log } from '../log.ts';
import { renderReplay, RenderError } from './wows-render.ts';
import {
  AlreadyQueuedError,
  DownloadError,
  QueueFullError,
  RenderQueue,
  downloadReplay,
  failureMessage,
  refuseAttachment,
  videoName,
} from './replay.ts';

/**
 * Discord's interaction token lasts 15 minutes. One render at a time, three
 * waiting and 150 s each puts the last in line at 10 minutes in the worst
 * case, with the download's 30 s on top; real renders take 4–14 s.
 */
const RENDER_TIMEOUT_MS = 150_000;
const queue = new RenderQueue(1, 3);

export const renderCommand = new SlashCommandBuilder()
  .setName('render')
  .setDescription('Turn a replay into a video of the battle.')
  .setContexts(InteractionContextType.Guild)
  .addAttachmentOption((o) =>
    o.setName('replay').setDescription('A .wowsreplay file from the game').setRequired(true),
  );

export async function handleRender(
  interaction: ChatInputCommandInteraction,
  render: { readonly bin: string; readonly dataDir: string },
): Promise<void> {
  const attachment = interaction.options.getAttachment('replay', true);
  const refusal = refuseAttachment(attachment.name, attachment.size);
  if (refusal !== null) {
    await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const started = Date.now();

  try {
    const result = await queue.run(
      interaction.user.id,
      async () => {
        await interaction.editReply('Rendering…').catch(() => {});
        const replay = await downloadReplay(attachment.url);
        return renderReplay({
          input: replay,
          binary: render.bin,
          dataDir: render.dataDir,
          maxMb: 8,
          timeoutMs: RENDER_TIMEOUT_MS,
        });
      },
      (position) => {
        void interaction
          .editReply(`Waiting for ${position === 1 ? 'one render' : `${position} renders`} ahead of this one…`)
          .catch(() => {});
      },
    );

    if (result.warnings.length > 0) log.warn(`/render warnings for ${attachment.name}: ${result.warnings.join('; ')}`);
    await interaction.editReply({
      content: '',
      files: [new AttachmentBuilder(result.mp4!, { name: videoName(attachment.name) })],
    });
    log.info(
      `/render ${attachment.name} for ${interaction.user.id}: ${result.frames} frames, ` +
        `${(result.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  } catch (error) {
    let message: string;
    if (error instanceof QueueFullError) message = 'Too many replays are waiting to render. Try again in a few minutes.';
    else if (error instanceof AlreadyQueuedError) message = 'You already have a replay rendering; wait for that one first.';
    else if (error instanceof DownloadError) message = 'I could not fetch that attachment from Discord. Try again.';
    else message = await failureMessage(error, render.dataDir);

    if (error instanceof RenderError) {
      const level = error.code === 'bad_replay' || error.code === 'unsupported_version' ? 'warn' : 'error';
      log[level](`/render ${attachment.name} failed: ${error.code}: ${error.message}${error.stderr ? `\n${error.stderr}` : ''}`);
    } else if (!(error instanceof QueueFullError || error instanceof AlreadyQueuedError)) {
      log.error(`/render ${attachment.name} failed`, error);
    }
    await interaction.editReply(message).catch(() => {});
  }
}
