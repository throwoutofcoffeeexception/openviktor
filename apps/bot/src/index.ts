import { prisma } from "@openviktor/db";
import { PipedreamClient } from "@openviktor/integrations";
import type { PipedreamConfig } from "@openviktor/integrations";
import { createLogger, isManaged, isSelfHosted, loadConfig } from "@openviktor/shared";
import {
	ConcurrencyExceededError,
	type Logger,
	ThreadLockedError,
	chunkMessage,
	markdownToMrkdwn,
} from "@openviktor/shared";
import {
	LocalToolBackend,
	ModalToolBackend,
	ToolGatewayClient,
	appendSlackLog,
	connectIntegrationDefinition,
	createConnectIntegrationExecutor,
	createDisconnectIntegrationExecutor,
	createIntegrationSyncHandler,
	createListAvailableIntegrationsExecutor,
	createListWorkspaceConnectionsExecutor,
	createNativeRegistry,
	createSubmitPermissionRequestExecutor,
	createSyncWorkspaceConnectionsExecutor,
	deploySdkToWorkspace,
	disconnectIntegrationDefinition,
	listAvailableIntegrationsDefinition,
	listWorkspaceConnectionsDefinition,
	registerDbTools,
	registerDynamicSlackTools,
	registerThreadOrchestrationTools,
	restoreToolsFromDb,
	submitPermissionRequestDefinition,
	syncWorkspaceConnectionsDefinition,
} from "@openviktor/tools";
import type { SpawnAgentRunParams } from "@openviktor/tools";
import type { RegistryConfig, ToolBackend } from "@openviktor/tools";
import { LLMGateway } from "./agent/gateway.js";
import { AnthropicProvider } from "./agent/providers/anthropic.js";
import { AgentRunner } from "./agent/runner.js";
import { readAgentGrantFile, readOwnerAgentBindingFile } from "./tool-gateway/agent-task-auth.js";
import { assertOwnerAgentBackend } from "./tool-gateway/agent-task-backend.js";
import { createAgentTaskGateway } from "./tool-gateway/agent-task.js";
import { createAgentTaskRuntime } from "./tool-gateway/agent-task-runtime.js";
import { createViktorA2AGateway, readViktorA2APublicKeyFile } from "./tool-gateway/viktor-a2a.js";
import { createScopedToolAccess } from "./tool-gateway/scoped-tools.js";
import { createBenchHandler } from "./bench/handler.js";
import {
	CronScheduler,
	createCronJobDefinition,
	createCronToolExecutors,
	createScriptCronDefinition,
	deleteCronJobDefinition,
	listCronJobsDefinition,
	triggerCronJobDefinition,
} from "./cron/index.js";
import {
	buildOnboardingPrompt,
	buildProactiveOnboardingPrompt,
	isOnboardingNeeded,
	markOnboardingComplete,
	seedChannelIntros,
} from "./cron/onboarding.js";
import { IntegrationWatcher } from "./integrations/watcher.js";
import { seedBuiltinSkills } from "./skills/seed.js";
import {
	ConnectionManager,
	type EventHandler,
	type InteractionHandler,
	type SlackConnection,
	type SlackEvent,
} from "./slack/connection-manager.js";
import { createEventsApiHandler } from "./slack/events-api.js";
import {
	buildPermissionMessage,
	createBotFilter,
	createDeduplicator,
	createSlackApp,
	registerEventHandlers,
	registerInteractionHandlers,
	startSlackApp,
} from "./slack/index.js";
import { createOAuthHandler } from "./slack/oauth.js";
import { resolveMember, resolveUserMentions, resolveWorkspace } from "./slack/resolve.js";
import type { SlackClient } from "./slack/resolve.js";
import { createConcurrencyLimiter } from "./thread/concurrency.js";
import { fetchActiveThreads } from "./thread/index.js";
import { ThreadLock } from "./thread/lock.js";
import { StaleThreadDetector } from "./thread/stale.js";
import { createDashboardApi } from "./tool-gateway/dashboard-api.js";
import { createToolGateway } from "./tool-gateway/server.js";
import { UsageLimiter } from "./usage/limiter.js";
import { UsageTracker } from "./usage/tracker.js";

const logger = createLogger("bot");

function createToolBackend(config: ReturnType<typeof loadConfig>): {
	backend: ToolBackend;
	registry: ReturnType<typeof createNativeRegistry>;
} {
	let llmProvider: import("@openviktor/shared").LLMProvider | undefined;
	if (config.ANTHROPIC_API_KEY) {
		llmProvider = new AnthropicProvider(config.ANTHROPIC_API_KEY);
	}
	const registryConfig: RegistryConfig = {
		slackToken: config.SLACK_BOT_TOKEN ?? "",
		githubToken: config.GITHUB_TOKEN,
		browserbaseApiKey: config.BROWSERBASE_API_KEY,
		context7BaseUrl: config.CONTEXT7_BASE_URL,
		searchApiKey: config.SEARCH_API_KEY,
		imagenApiKey: config.IMAGEN_API_KEY,
		llmProvider,
		defaultModel: config.DEFAULT_MODEL,
	};
	const registry = createNativeRegistry(registryConfig);
	registerDbTools(registry, prisma);

	if (config.TOOL_BACKEND === "modal") {
		const backend = new ModalToolBackend({
			endpointUrl: config.MODAL_ENDPOINT_URL as string,
			authToken: config.MODAL_AUTH_TOKEN,
			timeoutMs: config.TOOL_TIMEOUT_MS,
		});
		logger.info({ endpoint: config.MODAL_ENDPOINT_URL }, "Using Modal tool backend");
		return { backend, registry };
	}

	const backend = new LocalToolBackend(registry);
	logger.info("Using local tool backend");
	return { backend, registry };
}

// ─── Deduplication for unified event handler ────────────

function createEventDeduplicator(ttlMs = 300_000) {
	const seen = new Map<string, number>();
	return (key: string): boolean => {
		const now = Date.now();
		const seenAt = seen.get(key);
		if (seenAt !== undefined && now - seenAt < ttlMs) return true;
		seen.set(key, now);
		// Periodic cleanup
		if (seen.size > 10_000) {
			for (const [k, ts] of seen) {
				if (now - ts > ttlMs) seen.delete(k);
			}
		}
		return false;
	};
}

// ─── Main ───────────────────────────────────────────────

async function main(): Promise<void> {
	const config = loadConfig();
	assertOwnerAgentBackend(config.TOOL_BACKEND, process.env.VIKTOR_TWIN_GRANT_FILE ?? process.env.VIKTOR_TWIN_BINDING_FILE);
	const mode = config.DEPLOYMENT_MODE;

	await prisma.$connect();
	logger.info({ mode }, "Database connected");

	const { backend, registry } = createToolBackend(config);
	const gatewayDeps = {
		registry,
		backend,
		logger: createLogger("tool-gateway"),
		defaultTimeoutMs: config.TOOL_TIMEOUT_MS,
	};
	const gateway = createToolGateway(gatewayDeps);

	const gatewayPort = config.TOOL_GATEWAY_PORT;

	const gatewayClient = new ToolGatewayClient({
		baseUrl: `http://localhost:${gatewayPort}`,
		token: "local",
		timeoutMs: config.TOOL_TIMEOUT_MS,
	});

	const concurrencyLimiter = await createConcurrencyLimiter(
		config.MAX_CONCURRENT_RUNS,
		createLogger("concurrency"),
		config.REDIS_URL,
		config.AGENT_TIMEOUT_MS,
	);

	const threadLock = new ThreadLock(
		prisma,
		createLogger("thread-lock"),
		config.THREAD_LOCK_TIMEOUT_MS,
	);

	const staleDetector = new StaleThreadDetector(
		prisma,
		createLogger("stale-detector"),
		config.STALE_THREAD_TIMEOUT_MS,
		config.STALE_CHECK_INTERVAL_MS,
	);
	staleDetector.start();

	const usageTracker = new UsageTracker(prisma, createLogger("usage-tracker"));
	const usageLimiter = isManaged(config)
		? new UsageLimiter(prisma, createLogger("usage-limiter"), config.GLOBAL_MONTHLY_BUDGET_CENTS)
		: null;

	const llm = new LLMGateway(config);
	const runner = new AgentRunner(
		prisma,
		llm,
		createLogger("agent-runner"),
		{
			client: gatewayClient,
			tools: registry.getDefinitions(),
		},
		{
			concurrencyLimiter,
			threadLock,
			maxConcurrentRuns: config.MAX_CONCURRENT_RUNS,
		},
		undefined,
		(workspaceId) => createScopedToolAccess(workspaceId, gatewayPort,
			config.TOOL_TIMEOUT_MS, registry.getDefinitions()),
	);
	const grantPath = process.env.VIKTOR_TWIN_GRANT_FILE;
	const taskRuntime = grantPath
		? createAgentTaskRuntime(prisma, runner, (workspaceId) =>
			createScopedToolAccess(workspaceId, gatewayPort, config.TOOL_TIMEOUT_MS,
				registry.getDefinitions(), ["read_learnings"]))
		: null;
	const agentTasks = grantPath && taskRuntime
		? createAgentTaskGateway({ lookupGrant: readAgentGrantFile(grantPath), ...taskRuntime })
		: null;
	const a2aAudience = process.env.VIKTOR_A2A_AUDIENCE;
	const a2aTenant = process.env.VIKTOR_A2A_TENANT;
	const a2aPublicKeyFile = process.env.VIKTOR_A2A_PUBLIC_KEY_FILE;
	const bindingPath = process.env.VIKTOR_TWIN_BINDING_FILE;
	if ([a2aAudience, a2aTenant, a2aPublicKeyFile].some(Boolean)
		&& (!bindingPath || !a2aAudience || !a2aTenant || !a2aPublicKeyFile)) {
		throw new Error("Viktor A2A requires a permanent binding, tenant, audience and public verifier");
	}
	const a2aRuntime = bindingPath ? createAgentTaskRuntime(prisma, runner, (workspaceId) =>
		createScopedToolAccess(workspaceId, gatewayPort, config.TOOL_TIMEOUT_MS,
			registry.getDefinitions(), ["read_learnings"])) : null;
	const a2aTasks = bindingPath && a2aRuntime && a2aAudience && a2aTenant && a2aPublicKeyFile
		? createViktorA2AGateway({
			publicKey: readViktorA2APublicKeyFile(a2aPublicKeyFile),
			audience: a2aAudience, tenant: a2aTenant,
			readBinding: readOwnerAgentBindingFile(bindingPath), ...a2aRuntime,
		})
		: null;

	// Thread orchestration tools
	registerThreadOrchestrationTools(registry, {
		prisma,
		slackToken: config.SLACK_BOT_TOKEN ?? "",
		spawnAgentRun: (params: SpawnAgentRunParams) => {
			void runner.run({
				workspaceId: params.workspaceId,
				memberId: null,
				triggerType: "SPAWN",
				slackChannel: params.slackChannel,
				slackThreadTs: params.slackThreadTs,
				userMessage: params.initialPrompt,
				promptContext: {
					workspaceName: "",
					channel: params.slackChannel,
					triggerType: "SPAWN",
				},
			});
		},
	});

	const scheduler = new CronScheduler(prisma, runner, createLogger("cron-scheduler"), {
		checkIntervalMs: config.CRON_CHECK_INTERVAL_MS,
		heartbeatEnabled: config.HEARTBEAT_ENABLED,
		slackToken: config.SLACK_BOT_TOKEN ?? "",
		defaultModel: config.DEFAULT_MODEL,
		encryptionKey: config.ENCRYPTION_KEY,
		backend,
	});

	const cronTools = createCronToolExecutors(prisma, scheduler);
	const local = { localOnly: true };
	registry.register("create_cron_job", createCronJobDefinition, cronTools.create_cron_job, local);
	registry.register(
		"create_script_cron",
		createScriptCronDefinition,
		cronTools.create_script_cron,
		local,
	);
	registry.register("delete_cron_job", deleteCronJobDefinition, cronTools.delete_cron_job, local);
	registry.register(
		"trigger_cron_job",
		triggerCronJobDefinition,
		cronTools.trigger_cron_job,
		local,
	);
	registry.register("list_cron_jobs", listCronJobsDefinition, cronTools.list_cron_jobs, local);

	// Pipedream integration tools
	let integrationWatcher: IntegrationWatcher | undefined;
	let pdClient: PipedreamClient | undefined;
	let syncHandler: ReturnType<typeof createIntegrationSyncHandler> | undefined;
	const hasPipedream = !!(
		config.PIPEDREAM_CLIENT_ID &&
		config.PIPEDREAM_CLIENT_SECRET &&
		config.PIPEDREAM_PROJECT_ID
	);
	if (hasPipedream) {
		const pdConfig: PipedreamConfig = {
			clientId: config.PIPEDREAM_CLIENT_ID as string,
			clientSecret: config.PIPEDREAM_CLIENT_SECRET as string,
			projectId: config.PIPEDREAM_PROJECT_ID as string,
			environment: config.PIPEDREAM_ENVIRONMENT,
		};
		pdClient = new PipedreamClient(pdConfig);
		const skipPermissions = config.DANGEROUSLY_SKIP_PERMISSIONS;

		syncHandler = createIntegrationSyncHandler(registry, pdClient, prisma, skipPermissions);

		const refreshRunnerTools = () => {
			runner.updateToolConfig({
				client: gatewayClient,
				tools: registry.getDefinitions(),
			});
		};

		integrationWatcher = new IntegrationWatcher(
			pdClient,
			syncHandler,
			refreshRunnerTools,
			createLogger("integration-watcher"),
		);

		registry.register(
			"list_available_integrations",
			listAvailableIntegrationsDefinition,
			createListAvailableIntegrationsExecutor(pdClient),
			local,
		);
		registry.register(
			"list_workspace_connections",
			listWorkspaceConnectionsDefinition,
			createListWorkspaceConnectionsExecutor(prisma),
			local,
		);
		registry.register(
			"connect_integration",
			connectIntegrationDefinition,
			createConnectIntegrationExecutor(pdClient, (workspaceId, appSlug) => {
				integrationWatcher?.watch(workspaceId, appSlug);
			}),
			local,
		);
		registry.register(
			"disconnect_integration",
			disconnectIntegrationDefinition,
			createDisconnectIntegrationExecutor(syncHandler),
			local,
		);
		registry.register(
			"sync_workspace_connections",
			syncWorkspaceConnectionsDefinition,
			createSyncWorkspaceConnectionsExecutor(syncHandler),
			local,
		);
		registry.register(
			"submit_permission_request",
			submitPermissionRequestDefinition,
			createSubmitPermissionRequestExecutor(prisma),
			local,
		);

		const restored = await restoreToolsFromDb(registry, pdClient, prisma, skipPermissions);
		if (restored.length > 0) {
			logger.info({ count: restored.length }, "Restored Pipedream tools from database");
		}

		logger.info("Pipedream integration enabled");
	} else {
		logger.info("Pipedream integration disabled (no credentials configured)");
	}

	runner.updateToolConfig({
		client: gatewayClient,
		tools: registry.getDefinitions(),
	});

	// Deploy Python SDK to all active workspaces
	const allTools = registry.getAllDefinitions();
	prisma.workspace
		.findMany({ select: { id: true } })
		.then(async (workspaces) => {
			for (const ws of workspaces) {
				await deploySdkToWorkspace(ws.id, allTools).catch(() => {});
			}
			if (workspaces.length > 0) {
				logger.info({ count: workspaces.length }, "Deployed Python SDK to workspaces");
			}
		})
		.catch((err) => logger.warn({ err }, "Failed to deploy SDK to workspaces"));

	scheduler.start();

	// ─── Unified event handler ──────────────────────────

	const isDuplicate = createEventDeduplicator();
	const eventLogger = createLogger("events");

	async function fetchSkillCatalog(workspaceId: string): Promise<string[]> {
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

	async function fetchIntegrationCatalog(workspaceId: string): Promise<string[]> {
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

	async function addReaction(
		client: SlackClient,
		channel: string,
		timestamp: string,
		emoji: string,
	): Promise<void> {
		try {
			await client.reactions.add({ channel, timestamp, name: emoji });
		} catch (err) {
			eventLogger.warn({ err, channel, timestamp, emoji }, "Failed to add reaction");
		}
	}

	async function removeReaction(
		client: SlackClient,
		channel: string,
		timestamp: string,
		emoji: string,
	): Promise<void> {
		try {
			await client.reactions.remove({ channel, timestamp, name: emoji });
		} catch (err) {
			eventLogger.warn({ err, channel, timestamp, emoji }, "Failed to remove reaction");
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
	): Promise<void> {
		try {
			await say({
				text:
					text ??
					"Something went wrong while processing your request. Let me know if you'd like me to try again.",
				thread_ts: threadTs,
			});
		} catch (err) {
			eventLogger.warn({ err, threadTs }, "Failed to send error reply");
		}
	}

	const onEvent: EventHandler = async (event, connection, say) => {
		// Deduplication
		const dedupeKey = `${event.channel}:${event.ts}`;
		if (isDuplicate(dedupeKey)) return;

		// Bot filter
		if (event.botId || event.subtype === "bot_message") return;
		if (!event.user || !event.text) return;
		if (event.user === connection.botUserId) return;

		const client = connection.getClient() as unknown as SlackClient;
		const workspaceId = connection.workspaceId;
		const botUserId = connection.botUserId;

		// Register workspace token for tool gateway

		if (event.type === "message") {
			const isDm = event.channelType === "im";
			if (!isDm && !event.threadTs) return;

			// Check if bot is participating in thread
			if (!isDm && event.threadTs) {
				const participating = await prisma.thread.findFirst({
					where: {
						workspace: { slackTeamId: event.teamId },
						slackChannel: event.channel,
						slackThreadTs: event.threadTs,
					},
				});
				if (!participating) return;
			}
		}

		const threadTs = event.threadTs ?? event.ts;

		// Resolve workspace (ensure it exists in DB)
		const workspace = await resolveWorkspace(
			prisma,
			client,
			event.teamId,
			connection.getClient().token as string,
			botUserId,
		);

		// Resolve member
		const member = await resolveMember(prisma, client, workspace.id, event.user);

		// Log to Slack log
		appendSlackLog({
			workspaceId: workspace.id,
			channel: event.channel,
			ts: event.ts,
			threadTs: event.threadTs,
			username: member.displayName ?? event.user,
			text: event.text,
		}).catch((err) => eventLogger.warn({ err }, "Failed to write Slack log"));

		// Add hourglass reaction
		await addReaction(client, event.channel, event.ts, "hourglass_flowing_sand");

		// Prepare message
		const userMessage = await resolveUserMentions(event.text, prisma, client, workspace.id);
		const onboarding = await isOnboardingNeeded(prisma, workspace);

		let triggerType: "ONBOARDING" | "DM" | "MENTION" = "MENTION";
		if (onboarding) triggerType = "ONBOARDING";
		else if (event.type === "message" && event.channelType === "im") triggerType = "DM";

		// Try to join channel on mentions
		if (event.type === "app_mention") {
			try {
				await client.conversations.join({ channel: event.channel });
			} catch (err) {
				eventLogger.debug({ err, channel: event.channel }, "Could not join channel");
			}
		}

		const [skillCatalog, integrationCatalog, activeThreads] = await Promise.all([
			fetchSkillCatalog(workspace.id),
			fetchIntegrationCatalog(workspace.id),
			fetchActiveThreads(prisma, workspace.id),
		]);

		eventLogger.info(
			{ channel: event.channel, user: event.user, type: event.type, onboarding },
			"Event received",
		);

		// Usage enforcement (managed mode only)
		if (usageLimiter) {
			const budget = await usageLimiter.canRun(workspace.id);
			if (!budget.allowed) {
				await removeReaction(client, event.channel, event.ts, "hourglass_flowing_sand");
				const resetDate = new Date(budget.resetsAt).toLocaleDateString("en-US", {
					month: "long",
					day: "numeric",
				});
				await safeReply(
					say,
					threadTs,
					`Your workspace has reached its free tier usage limit ($${(budget.limitCents / 100).toFixed(0)}/month). Usage resets on ${resetDate}.`,
				);
				return;
			}
		}

		try {
			const result = await runner.run({
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

			// Record usage (fire-and-forget)
			void usageTracker.record(workspace.id, {
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				costCents: result.costCents,
				toolExecutions: 0,
			});

			if (onboarding) {
				await markOnboardingComplete(prisma, workspace);
				await seedChannelIntros(prisma, workspace.id, eventLogger);
				await seedBuiltinSkills(prisma, workspace.id, eventLogger);
			}

			if (!result.messageSent) {
				await sendResponse(say, result.responseText, threadTs);
			}
			await removeReaction(client, event.channel, event.ts, "hourglass_flowing_sand");
		} catch (error) {
			await removeReaction(client, event.channel, event.ts, "hourglass_flowing_sand");
			if (error instanceof ThreadLockedError) {
				await addReaction(client, event.channel, event.ts, "eyes");
				runner.injectMessage(event.channel, threadTs, userMessage);
				return;
			}
			if (error instanceof ConcurrencyExceededError) {
				await safeReply(
					say,
					threadTs,
					"I'm handling several requests right now. Please try again in a moment.",
				);
				return;
			}
			eventLogger.error({ err: error, event: event.type }, "Failed to handle event");
			await safeReply(say, threadTs);
		}
	};

	const onInteraction: InteractionHandler = async (interaction, connection) => {
		if (interaction.type !== "block_actions") return;

		const body = interaction.payload as Record<string, unknown>;
		const actions = (body.actions ?? []) as Array<{ action_id?: string; value?: string }>;
		const userId = ((body.user as Record<string, unknown>)?.id as string) ?? "unknown";
		const client = connection.getClient();

		for (const action of actions) {
			const requestId = action.value;
			if (!requestId) continue;

			if (action.action_id === "permission_approve") {
				const result = await prisma.permissionRequest.updateMany({
					where: { id: requestId, status: "PENDING", expiresAt: { gt: new Date() } },
					data: { status: "APPROVED", approvedBy: userId, resolvedAt: new Date() },
				});
				const request = await prisma.permissionRequest.findUnique({ where: { id: requestId } });
				if (request?.slackChannel && request.slackMessageTs) {
					const text =
						result.count > 0
							? `Approved by <@${userId}>. Executing \`${request.toolName}\`...`
							: `Permission request already ${(request.status ?? "unknown").toLowerCase()}.`;
					try {
						await client.chat.update({
							channel: request.slackChannel,
							ts: request.slackMessageTs,
							text,
							blocks: [],
						});
					} catch (err) {
						eventLogger.warn({ err }, "Failed to update permission message");
					}
				}
			} else if (action.action_id === "permission_reject") {
				const result = await prisma.permissionRequest.updateMany({
					where: { id: requestId, status: "PENDING" },
					data: { status: "REJECTED", approvedBy: userId, resolvedAt: new Date() },
				});
				const request = await prisma.permissionRequest.findUnique({ where: { id: requestId } });
				if (request?.slackChannel && request.slackMessageTs) {
					const text =
						result.count > 0
							? `Rejected by <@${userId}>.`
							: `Permission request already ${(request.status ?? "unknown").toLowerCase()}.`;
					try {
						await client.chat.update({
							channel: request.slackChannel,
							ts: request.slackMessageTs,
							text,
							blocks: [],
						});
					} catch (err) {
						eventLogger.warn({ err }, "Failed to update permission message");
					}
				}
			}
		}
	};

	// ─── ConnectionManager ──────────────────────────────

	const connectionManager = new ConnectionManager({
		config,
		prisma,
		logger: createLogger("connections"),
		onEvent,
		onInteraction,
	});

	// ─── Dynamic Slack tools (managed mode) ─────────────

	if (isManaged(config) && !config.SLACK_BOT_TOKEN) {
		registerDynamicSlackTools(registry, (workspaceId) => {
			const conn = connectionManager.getConnection(workspaceId);
			if (!conn) return null;
			return (conn.getClient().token as string) ?? null;
		});
		runner.updateToolConfig({
			client: gatewayClient,
			tools: registry.getDefinitions(),
		});
		logger.info("Registered dynamic Slack tools for managed mode");
	}

	// ─── Dashboard API ──────────────────────────────────

	let dashboardApi: { fetch: (req: Request) => Promise<Response> } | undefined;
	if (config.ENABLE_DASHBOARD) {
		dashboardApi = createDashboardApi({
			config,
			prisma,
			connectionManager,
			pdClient,
			integrationWatcher,
			disconnectApp: syncHandler?.disconnectApp.bind(syncHandler),
			usageLimiter: usageLimiter ?? undefined,
			logger: createLogger("dashboard-api"),
		});
		logger.info("Dashboard API enabled");
	}

	// ─── Gateway Server ─────────────────────────────────

	let eventsApiHandler: ReturnType<typeof createEventsApiHandler> | undefined;
	let oauthHandler: ReturnType<typeof createOAuthHandler> | undefined;

	if (isManaged(config)) {
		eventsApiHandler = createEventsApiHandler({
			signingSecret: config.SLACK_SIGNING_SECRET,
			connectionManager,
			onEvent,
			onInteraction,
			logger: createLogger("events-api"),
		});

		async function runProactiveOnboarding(
			workspaceId: string,
			installerSlackUserId: string,
		): Promise<void> {
			const workspace = await prisma.workspace.findUnique({
				where: { id: workspaceId },
			});
			if (!workspace) return;

			// Skip if onboarding already completed (re-install)
			const settings = workspace.settings as Record<string, unknown> | null;
			if (settings?.onboardingCompletedAt) {
				eventLogger.info({ workspaceId }, "Skipping proactive onboarding — already completed");
				return;
			}

			const connection = connectionManager.getConnection(workspaceId);
			if (!connection) {
				eventLogger.warn({ workspaceId }, "No connection for proactive onboarding");
				return;
			}

			// Open DM with installer
			const dm = await connection.getClient().conversations.open({
				users: installerSlackUserId,
			});
			const dmChannel = dm.channel?.id;
			if (!dmChannel) {
				eventLogger.warn({ workspaceId, installerSlackUserId }, "Failed to open DM for onboarding");
				return;
			}

			// Mark onboarding complete immediately to prevent reactive onboarding race
			await markOnboardingComplete(prisma, { id: workspace.id, settings: workspace.settings });

			const member = await prisma.member.findFirst({
				where: { workspaceId, slackUserId: installerSlackUserId },
			});

			const prompt = buildProactiveOnboardingPrompt(installerSlackUserId);

			const result = await runner.run({
				workspaceId,
				memberId: member?.id ?? null,
				triggerType: "ONBOARDING",
				slackChannel: dmChannel,
				slackThreadTs: `onboarding-${workspaceId}-${Date.now()}`,
				userMessage: prompt,
				promptContext: {
					workspaceName: workspace.slackTeamName,
					channel: dmChannel,
					triggerType: "ONBOARDING",
					onboardingPrompt: prompt,
				},
			});

			void usageTracker.record(workspaceId, {
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				costCents: result.costCents,
				toolExecutions: 0,
			});

			await seedChannelIntros(prisma, workspaceId, eventLogger);
			await seedBuiltinSkills(prisma, workspaceId, eventLogger);
			eventLogger.info({ workspaceId }, "Proactive onboarding completed");
		}

		oauthHandler = createOAuthHandler({
			config,
			prisma,
			connectionManager,
			logger: createLogger("oauth"),
			onInstall: (workspaceId, installerSlackUserId) => {
				void runProactiveOnboarding(workspaceId, installerSlackUserId).catch((err) =>
					eventLogger.error({ err, workspaceId }, "Proactive onboarding failed"),
				);
			},
		});
	}

	const corsHeaders: Record<string, string> = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Workspace-Id",
	};

	let benchHandler: ReturnType<typeof createBenchHandler> | undefined;
	const gatewayServer = Bun.serve({
		port: gatewayPort,
		fetch: async (req: Request) => {
			const url = new URL(req.url, "http://localhost");
			if (a2aAudience && (url.pathname === new URL(a2aAudience).pathname
				|| url.pathname === "/.well-known/agent-card.json")) {
				return a2aTasks ? a2aTasks.fetch(req) : Response.json({ error: "Not found" }, { status: 404 });
			}
			if (url.pathname === "/v1/agent/run") {
				return agentTasks ? agentTasks.fetch(req) : Response.json({ error: "Not found" }, { status: 404 });
			}

			if (url.pathname === "/bench/message") {
				return benchHandler
					? benchHandler(req)
					: Response.json({ error: "not_found" }, { status: 404 });
			}

			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders });
			}

			// Slack Events API (managed mode)
			if (url.pathname === "/slack/events" && eventsApiHandler) {
				return eventsApiHandler.handleEventsRequest(req);
			}
			if (url.pathname === "/slack/interactions" && eventsApiHandler) {
				return eventsApiHandler.handleInteractionsRequest(req);
			}

			// Slack OAuth (managed mode)
			if (url.pathname === "/slack/oauth/install" && oauthHandler) {
				return oauthHandler.handleInstall(req);
			}
			if (url.pathname === "/slack/oauth/callback" && oauthHandler) {
				return oauthHandler.handleCallback(req);
			}

			// Dashboard API
			if (url.pathname.startsWith("/api/") && dashboardApi) {
				const response = await dashboardApi.fetch(req);
				for (const [key, value] of Object.entries(corsHeaders)) {
					response.headers.set(key, value);
				}
				return response;
			}

			// Tool gateway
			return gateway.fetch(req);
		},
	});
	logger.info(
		{ port: gatewayServer.port, tools: registry.getAllDefinitions().map((t) => t.name) },
		"Tool gateway started",
	);

	// ─── Mode-specific startup ──────────────────────────

	if (isSelfHosted(config)) {
		// Self-hosted: use existing Bolt App for primary workspace, ConnectionManager for tracking
		const app = createSlackApp(config);
		app.use(createDeduplicator());
		app.use(createBotFilter(logger));
		registerEventHandlers(app, { prisma, runner, logger });
		registerInteractionHandlers(app, { prisma, logger: createLogger("interactions") });
		await startSlackApp(app);

		// Resolve the primary workspace and register in ConnectionManager
		const authResult = await app.client.auth.test();
		const teamId = authResult.team_id as string;
		const botUserId = authResult.user_id as string;
		const botToken = config.SLACK_BOT_TOKEN as string;

		const workspace = await resolveWorkspace(
			prisma,
			app.client as unknown as SlackClient,
			teamId,
			botToken,
			botUserId,
		);

		if (process.env.BENCH_TOKEN) {
			benchHandler = createBenchHandler({
				token: process.env.BENCH_TOKEN,
				workspaceId: workspace.id,
				workspaceName: workspace.slackTeamName,
				runner,
				getContext: async () => {
					const [skillCatalog, integrationCatalog, activeThreads] = await Promise.all([
						fetchSkillCatalog(workspace.id),
						fetchIntegrationCatalog(workspace.id),
						fetchActiveThreads(prisma, workspace.id),
					]);
					return { skillCatalog, integrationCatalog, activeThreads };
				},
				getToolCalls: (agentRunId) =>
					prisma.toolCall.findMany({
						where: { agentRunId },
						select: { toolName: true, status: true, durationMs: true, output: true },
						orderBy: [{ createdAt: "asc" }, { id: "asc" }],
					}),
				getAvailableTools: () => registry.getDefinitions().map((tool) => tool.name),
			});
		}

		// Register existing Bolt app in ConnectionManager for health checks and dashboard API
		// (don't create a second SocketModeConnection)
		connectionManager.registerExisting(workspace.id, teamId, {
			workspaceId: workspace.id,
			teamId,
			botUserId,
			start: async () => {},
			stop: async () => {
				await app.stop();
			},
			getClient: () => app.client,
			isConnected: () => true,
		});

		// Approval gate for permissions
		if (!config.DANGEROUSLY_SKIP_PERMISSIONS) {
			const slackClient = app.client;
			runner.updateApprovalGate({
				slackPoster: {
					postMessage: async (channel, threadTs, opts) => {
						try {
							const result = await slackClient.chat.postMessage({
								channel,
								thread_ts: threadTs,
								text: opts.text,
								blocks: opts.blocks as never[],
							});
							return result.ts ?? null;
						} catch (err) {
							logger.error({ err, channel }, "Failed to post permission message");
							return null;
						}
					},
				},
				buildPermissionMessage,
			});
			logger.info("Approval gate enabled");
		}

		const shutdown = async () => {
			logger.info("Shutting down");
			integrationWatcher?.stop();
			staleDetector.stop();
			scheduler.stop();
			await concurrencyLimiter.shutdown();
			gatewayServer.stop();
			await app.stop();
			await connectionManager.disconnectAll();
			await prisma.$disconnect();
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		logger.info({ mode, teamId, workspaceId: workspace.id }, "OpenViktor started (self-hosted)");
	} else {
		// Managed: use Events API, workspaces connect via OAuth
		await connectionManager.connectAll();

		// Approval gate: post permission messages using workspace-specific client
		if (!config.DANGEROUSLY_SKIP_PERMISSIONS) {
			runner.updateApprovalGate({
				slackPoster: {
					postMessage: async (channel, threadTs, opts) => {
						// Find the workspace for this channel by checking all connections
						for (const conn of connectionManager.getAll()) {
							try {
								const result = await conn.getClient().chat.postMessage({
									channel,
									thread_ts: threadTs,
									text: opts.text,
									blocks: opts.blocks as never[],
								});
								return result.ts ?? null;
							} catch {}
						}
						logger.error({ channel }, "No connection could post permission message");
						return null;
					},
				},
				buildPermissionMessage,
			});
			logger.info("Approval gate enabled (managed mode)");
		}

		const shutdown = async () => {
			logger.info("Shutting down");
			integrationWatcher?.stop();
			staleDetector.stop();
			scheduler.stop();
			await concurrencyLimiter.shutdown();
			gatewayServer.stop();
			await connectionManager.disconnectAll();
			await prisma.$disconnect();
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		logger.info(
			{ mode, workspaces: connectionManager.connectedCount },
			"OpenViktor started (managed)",
		);
	}
}

main().catch((err) => {
	logger.error({ err }, "Fatal error during startup");
	process.exit(1);
});
