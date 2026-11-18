/**
 * Entry point. Opens the database, connects to Discord, and serves the
 * endpoints the suite talks to.
 *
 * It reads no messages. It exists so that a copy of the suite can sign in
 * with Discord and post a plan into a channel, and it only ever posts where
 * the person sharing could post themselves. Its one slash command, /render,
 * is there only when the renderer is set up.
 */

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handleRender, renderCommand } from './render/command.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { startHttpServer } from './http.ts';
import { log } from './log.ts';

/** View Channel, Send Messages, Embed Links and Attach Files: what a plan post needs. */
const INVITE_PERMISSIONS = 1024 + 2048 + 16384 + 32768;

const config = loadConfig();
const db = openDatabase(config.dbPath);

// Guilds is the only intent: it keeps servers and channels cached for the
// permission checks. Members are fetched one at a time when someone signs in
// or shares, which needs no privileged intent.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  log.info(`connected as ${ready.user.tag} (${ready.user.id})`);

  // Global commands: every server the bot is in gets /render, or loses it
  // again when the renderer is no longer set up.
  try {
    await ready.application.commands.set(config.render ? [renderCommand.toJSON()] : []);
    log.info(config.render ? '/render is on' : '/render is off (no renderer set up)');
  } catch (error) {
    log.error('registering /render failed', error);
  }

  for (const guild of ready.guilds.cache.values()) {
    log.info(`serving ${guild.name} (${guild.id})`);
  }

  if (client.guilds.cache.size === 0) {
    const invite = new URL('https://discord.com/oauth2/authorize');
    invite.search = new URLSearchParams({
      client_id: config.appId,
      scope: 'bot applications.commands',
      permissions: String(INVITE_PERMISSIONS),
    }).toString();
    log.info(`not in any server yet. Add it with: ${invite.toString()}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'render') return;
  if (config.render === null) {
    await interaction
      .reply({ content: 'Rendering is not set up on this bot.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }
  await handleRender(interaction, config.render);
});

client.on(Events.GuildCreate, (guild) => {
  log.info(`added to ${guild.name} (${guild.id})`);
});

const http = startHttpServer(client, config, db);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`${signal} received, shutting down`);
  http.close();
  await client.destroy();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  log.error('uncaught exception; exiting so the supervisor restarts it', error);
  process.exit(1);
});

await client.login(config.token);
