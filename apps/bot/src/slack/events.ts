import type { PrismaClient } from "@openviktor/db";
import {
	ConcurrencyExceededError,
	type Logger,
	ThreadLockedError,
	chunkMessage,
	markdownToMrkdwn,
} from "@openviktor/shared";
import { appendSlackLog } from "@openviktor/tools";
import type { App } from "@slack/bolt";
import type { AgentRunner } from "../agent/runner.js";
import {
	buildOnboardingPrompt,
	isOnboardingNeeded,
	markOnboardingComplete,
	seedChannelIntros,
} from "../cron/onboarding.js";
import { seedBuiltinSkills } from "../skills/seed.js";
import { fetchActiveThreads } from "../thread/index.js";
import {
	type SlackClient,
	resolveMember,
	resolveUserMentions,
	resolveWorkspace,
} from "./resolve.js";

export interface BotContext {
	prisma: PrismaClient;
	runner: AgentRunner;
	logger: Logger;
}

interface SlackMessage {
	channel: string;
	channel_type?: string;
	user?: string;
	text?: string;
	thread_ts?: string;
	ts: string;
	subtype?: string;
	bot_id?: string;
}

async function resolveContext(
	ctx: BotContext,
	client: unknown,
	teamId: string,
	botToken: string,
	botUserId: string,
	slackUserId: string,
) {
	const slackClient = client as unknown as SlackClient;
	const workspace = await resolveWorkspace(ctx.prisma, slackClient, teamId, botToken, botUserId);
	const member = await resolveMember(ctx.prisma, slackClient, workspace.id, slackUserId);
	return { workspace, member };
}

async function fetchSkillCatalog(prisma: PrismaClient, workspaceId: string): Promise<string[]> {
	const skills = await prisma.skill.findMany({
		where: { workspaceId },
		select: { name: true, description: true, version: true },
		orderBy: { name: "asc" },
	});
	return skills.map((s) => {
		const desc = s.description ? ` — ${s.description}` : "";
		return `${s.name} (v${s.version})${desc}`;
	});
}

async function fetchIntegrationCatalog(
	prisma: PrismaClient,
	workspaceId: string,
): Promise<string[]> {
	const skills = await prisma.skill.findMany({
		where: { workspaceId, name: { startsWith: "pd_" } },
		select: { name: true, description: true },
		orderBy: { name: "asc" },
	});
	return skills.map((s) => {
		const appName = s.name.replace(/^pd_/, "");
		const desc = s.description ?? appName;
		return `${appName}: ${desc}`;
	});
}

async function isBotInThread(
	prisma: PrismaClient,
	teamId: string,
	channel: string,
	threadTs: string,
): Promise<boolean> {
	const existing = await prisma.thread.findFirst({
		where: {
			workspace: { slackTeamId: teamId },
			slackChannel: channel,
			slackThreadTs: threadTs,
		},
	});
	return existing !== null;
}

async function handleMessage(
	ctx: BotContext,
	msg: SlackMessage,
	client: unknown,
	teamId: string,
	botToken: string,
	botUserId: string,
	say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>,
): Promise<void> {
	const isDm = msg.channel_type === "im";
	const threadTs = msg.thread_ts ?? msg.ts;

	if (!isDm && msg.thread_ts) {
		const participating = await isBotInThread(ctx.prisma, teamId, msg.channel, msg.thread_ts);
		if (!participating) return;
	}

	const slackClient = client as unknown as SlackClient;

	const { workspace, member } = await resolveContext(
		ctx,
		client,
		teamId,
		botToken,
		botUserId,
		msg.user as string,
	);

	appendSlackLog({
		workspaceId: workspace.id,
		channel: msg.channel,
		ts: msg.ts,
		threadTs: msg.thread_ts,
		username: member.displayName ?? msg.user ?? "unknown",
		text: msg.text ?? "",
	}).catch((err) => ctx.logger.warn({ err }, "Failed to write Slack log"));

	await addReaction(slackClient, msg.channel, msg.ts, "hourglass_flowing_sand", ctx.logger);

	const userMessage = await resolveUserMentions(
		msg.text as string,
		ctx.prisma,
		slackClient,
		workspace.id,
	);
	const onboarding = await isOnboardingNeeded(ctx.prisma, workspace);
	let triggerType: "ONBOARDING" | "DM" | "MENTION" = "MENTION";
	if (onboarding) triggerType = "ONBOARDING";
	else if (isDm) triggerType = "DM";

	const [skillCatalog, integrationCatalog, activeThreads] = await Promise.all([
		fetchSkillCatalog(ctx.prisma, workspace.id),
		fetchIntegrationCatalog(ctx.prisma, workspace.id),
		fetchActiveThreads(ctx.prisma, workspace.id),
	]);

	try {
		const result = await ctx.runner.run({
			workspaceId: workspace.id,
			memberId: member.id,
			triggerType,
			slackChannel: msg.channel,
			slackThreadTs: threadTs,
			userMessage: onboarding ? buildOnboardingPrompt(userMessage) : userMessage,
			promptContext: {
				workspaceName: workspace.slackTeamName,
				channel: msg.channel,
				slackThreadTs: threadTs,
				userMessageTs: msg.ts,
				triggerType,
				userName: member.displayName ?? undefined,
				skillCatalog,
				integrationCatalog,
				activeThreads,
				...(onboarding ? { onboardingPrompt: buildOnboardingPrompt(userMessage) } : {}),
			},
		});

		if (onboarding) {
			await markOnboardingComplete(ctx.prisma, workspace);
			await seedChannelIntros(ctx.prisma, workspace.id, ctx.logger);
			await seedBuiltinSkills(ctx.prisma, workspace.id, ctx.logger);
		}

		if (!result.messageSent) {
			await sendResponse(say, result.responseText, threadTs);
		}
		await removeReaction(slackClient, msg.channel, msg.ts, "hourglass_flowing_sand", ctx.logger);
	} catch (error) {
		await removeReaction(slackClient, msg.channel, msg.ts, "hourglass_flowing_sand", ctx.logger);
		if (error instanceof ThreadLockedError) {
			await addReaction(slackClient, msg.channel, msg.ts, "eyes", ctx.logger);
			ctx.runner.injectMessage(msg.channel, threadTs, userMessage);
			return;
		}
		throw error;
	}
}

async function sendResponse(
	say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>,
	responseText: string,
	threadTs: string,
): Promise<void> {
	const text = responseText.trim();
	if (!text) return;
	const mrkdwn = markdownToMrkdwn(text);
	const chunks = chunkMessage(mrkdwn).filter((c) => c.trim().length > 0);
	if (chunks.length === 0) chunks.push(text);
	for (const chunk of chunks) {
		await say({ text: chunk, thread_ts: threadTs });
	}
}

async function safeReply(
	say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>,
	threadTs?: string,
	text?: string,
	logger?: Logger,
): Promise<void> {
	try {
		await say({
			text:
				text ??
				"Something went wrong while processing your request. Let me know if you'd like me to try again.",
			thread_ts: threadTs,
		});
	} catch (err) {
		logger?.warn({ err, threadTs }, "Failed to send error reply");
	}
}

function orchestratorRejectionMessage(error: unknown): string | null {
	if (error instanceof ThreadLockedError) {
		return "I'm still working on your previous message. I'll respond as soon as I'm done.";
	}
	if (error instanceof ConcurrencyExceededError) {
		return "I'm handling several requests right now. Please try again in a moment.";
	}
	return null;
}

async function handleEventError(
	ctx: BotContext,
	error: unknown,
	eventName: string,
	say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>,
	threadTs?: string,
): Promise<void> {
	const rejection = orchestratorRejectionMessage(error);
	if (rejection) {
		await safeReply(say, threadTs, rejection, ctx.logger);
		return;
	}
	ctx.logger.error({ err: error, event: eventName }, `Failed to handle ${eventName}`);
	await safeReply(say, threadTs, undefined, ctx.logger);
}

async function addReaction(
	client: SlackClient,
	channel: string,
	timestamp: string,
	emoji: string,
	logger?: Logger,
): Promise<void> {
	try {
		await client.reactions.add({ channel, timestamp, name: emoji });
	} catch (err) {
		logger?.warn({ err, channel, timestamp, emoji }, "Failed to add reaction");
	}
}

async function removeReaction(
	client: SlackClient,
	channel: string,
	timestamp: string,
	emoji: string,
	logger?: Logger,
): Promise<void> {
	try {
		await client.reactions.remove({ channel, timestamp, name: emoji });
	} catch (err) {
		logger?.warn({ err, channel, timestamp, emoji }, "Failed to remove reaction");
	}
}

function isActionableMessage(msg: SlackMessage, botUserId?: string): boolean {
	return !msg.subtype && !msg.bot_id && !!msg.user && !!msg.text && msg.user !== botUserId;
}

async function handleMention(
	ctx: BotContext,
	event: { channel: string; ts: string; thread_ts?: string; user: string; text: string },
	client: unknown,
	teamId: string,
	botToken: string,
	botUserId: string,
	say: (opts: { text: string; thread_ts?: string }) => Promise<unknown>,
): Promise<void> {
	const threadTs = event.thread_ts ?? event.ts;
	const slackClient = client as unknown as SlackClient;

	try {
		await slackClient.conversations.join({ channel: event.channel });
	} catch (err) {
		ctx.logger.debug({ err, channel: event.channel }, "Could not join channel");
	}

	const { workspace, member } = await resolveContext(
		ctx,
		client,
		teamId,
		botToken,
		botUserId,
		event.user,
	);

	appendSlackLog({
		workspaceId: workspace.id,
		channel: event.channel,
		ts: event.ts,
		threadTs: event.thread_ts,
		username: member.displayName ?? event.user,
		text: event.text,
	}).catch((err) => ctx.logger.warn({ err }, "Failed to write Slack log"));

	await addReaction(slackClient, event.channel, event.ts, "hourglass_flowing_sand", ctx.logger);

	const userMessage = await resolveUserMentions(event.text, ctx.prisma, slackClient, workspace.id);
	const onboarding = await isOnboardingNeeded(ctx.prisma, workspace);
	const triggerType = onboarding ? "ONBOARDING" : "MENTION";

	const [skillCatalog, integrationCatalog, activeThreads] = await Promise.all([
		fetchSkillCatalog(ctx.prisma, workspace.id),
		fetchIntegrationCatalog(ctx.prisma, workspace.id),
		fetchActiveThreads(ctx.prisma, workspace.id),
	]);

	ctx.logger.info({ channel: event.channel, user: event.user, onboarding }, "Mention received");

	try {
		const result = await ctx.runner.run({
			workspaceId: workspace.id,
			memberId: member.id,
			triggerType,
			slackChannel: event.channel,
			slackThreadTs: threadTs,
			userMessage: onboarding ? buildOnboardingPrompt(userMessage) : userMessage,
			promptContext: {
				workspaceName: workspace.slackTeamName,
				channel: event.channel,
				slackThreadTs: threadTs,
				userMessageTs: event.ts,
				triggerType,
				userName: member.displayName ?? undefined,
				skillCatalog,
				integrationCatalog,
				activeThreads,
				...(onboarding ? { onboardingPrompt: buildOnboardingPrompt(userMessage) } : {}),
			},
		});

		if (onboarding) {
			await markOnboardingComplete(ctx.prisma, workspace);
			await seedChannelIntros(ctx.prisma, workspace.id, ctx.logger);
			await seedBuiltinSkills(ctx.prisma, workspace.id, ctx.logger);
		}

		if (!result.messageSent) {
			await sendResponse(say, result.responseText, threadTs);
		}
		await removeReaction(
			slackClient,
			event.channel,
			event.ts,
			"hourglass_flowing_sand",
			ctx.logger,
		);
	} catch (error) {
		await removeReaction(
			slackClient,
			event.channel,
			event.ts,
			"hourglass_flowing_sand",
			ctx.logger,
		);
		if (error instanceof ThreadLockedError) {
			await addReaction(slackClient, event.channel, event.ts, "eyes", ctx.logger);
			ctx.runner.injectMessage(event.channel, threadTs, userMessage);
			return;
		}
		throw error;
	}
}

export function registerEventHandlers(app: App, ctx: BotContext): void {
	app.event("app_mention", async ({ event, say, context, client }) => {
		const threadTs = event.thread_ts ?? event.ts;
		const { teamId, botUserId, botToken } = context;
		if (!teamId || !botUserId || !botToken || !event.user || !event.text) {
			ctx.logger.error("Missing required fields in app_mention event or context");
			return;
		}

		const mentionEvent = {
			channel: event.channel,
			ts: event.ts,
			thread_ts: event.thread_ts,
			user: event.user,
			text: event.text,
		};

		try {
			await handleMention(ctx, mentionEvent, client, teamId, botToken, botUserId, say);
		} catch (error) {
			await handleEventError(ctx, error, "app_mention", say, threadTs);
		}
	});

	app.event("message", async ({ event, say, context, client }) => {
		const msg = event as unknown as SlackMessage;
		const { teamId, botUserId, botToken } = context;

		if (!isActionableMessage(msg, botUserId)) return;

		const isDm = msg.channel_type === "im";
		if (!isDm && !msg.thread_ts) return;

		if (!teamId || !botUserId || !botToken) {
			ctx.logger.error("Missing teamId, botUserId, or botToken in context");
			return;
		}

		ctx.logger.info(
			{ channel: msg.channel, user: msg.user, isDm, threadTs: msg.thread_ts ?? msg.ts },
			"Message received",
		);

		try {
			await handleMessage(ctx, msg, client, teamId, botToken, botUserId, say);
		} catch (error) {
			const eventName = isDm ? "message_im" : "message_thread";
			await handleEventError(ctx, error, eventName, say, msg.thread_ts ?? msg.ts);
		}
	});
}
