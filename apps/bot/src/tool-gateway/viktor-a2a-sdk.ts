import { type KeyObject, createPublicKey, verify } from "node:crypto";
import { type AgentCard, Role, type Task, TaskState } from "@a2a-js/sdk";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import {
	AgentEvent,
	type AgentExecutor,
	DefaultRequestHandler,
	type ExecutionEventBus,
	InMemoryTaskStore,
	JsonRpcTransportHandler,
	type RequestContext,
	ServerCallContext,
} from "@a2a-js/sdk/server";

const OWNER = /^owner:tg:[1-9][0-9]*$/;

export interface ViktorA2ABackend {
	run(input: { ownerId: string; text: string }): Promise<string>;
}

export interface ViktorA2ASdkConfig {
	url: string;
	tenant: string;
	ownerId: string;
	publicKey: KeyObject;
	backend: ViktorA2ABackend;
}

function decodePart(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function verifyOwner(header: string | null, config: ViktorA2ASdkConfig): string | null {
	if (!header?.startsWith("Bearer ")) return null;
	const parts = header.slice(7).split(".");
	if (parts.length !== 3) return null;
	const [encodedHeader, encodedClaims, encodedSignature] = parts;
	const jwtHeader = decodePart(encodedHeader);
	const claims = decodePart(encodedClaims);
	if (
		!jwtHeader ||
		jwtHeader.alg !== "EdDSA" ||
		jwtHeader.typ !== "JWT" ||
		!claims ||
		claims.iss !== "twin" ||
		claims.aud !== config.url ||
		typeof claims.sub !== "string" ||
		!OWNER.test(claims.sub) ||
		claims.sub !== config.ownerId ||
		typeof claims.iat !== "number" ||
		typeof claims.exp !== "number" ||
		claims.exp <= Math.floor(Date.now() / 1000) ||
		claims.exp <= claims.iat
	)
		return null;
	try {
		return verify(
			null,
			Buffer.from(`${encodedHeader}.${encodedClaims}`),
			config.publicKey,
			Buffer.from(encodedSignature, "base64url"),
		)
			? claims.sub
			: null;
	} catch {
		return null;
	}
}

function textFromContext(context: RequestContext): string | null {
	const text = context.userMessage.parts
		.map((part) => (part.content?.$case === "text" ? part.content.value : ""))
		.join("")
		.trim();
	return text || null;
}

function createAgentCard(url: string, tenant: string): AgentCard {
	return {
		name: "Viktor",
		description: "Owner-scoped workspace agent",
		supportedInterfaces: [{ protocolBinding: "JSONRPC", url, tenant, protocolVersion: "1.0" }],
		provider: { organization: "SMH-projects", url: "https://github.com/SMH-projects/openviktor" },
		version: "1.0.0",
		capabilities: { streaming: false, pushNotifications: false, extensions: [] },
		securitySchemes: {
			ownerJwt: {
				scheme: {
					$case: "httpAuthSecurityScheme",
					value: {
						description: "Twin owner JWT",
						scheme: "Bearer",
						bearerFormat: "JWT",
					},
				},
			},
		},
		securityRequirements: [{ schemes: { ownerJwt: { list: [] } } }],
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [
			{
				id: "viktor.workspace",
				name: "Workspace agent",
				description: "Run a scoped workspace task.",
				tags: ["workspace"],
				examples: [],
				inputModes: ["text/plain"],
				outputModes: ["text/plain"],
				securityRequirements: [{ schemes: { ownerJwt: { list: [] } } }],
			},
		],
		signatures: [],
	};
}

function createExecutor(config: ViktorA2ASdkConfig): AgentExecutor {
	return {
		execute: async (context, events) => {
			const ownerId = context.context.state.get("ownerId");
			const text = textFromContext(context);
			if (
				typeof ownerId !== "string" ||
				!OWNER.test(ownerId) ||
				context.userMessage.role !== Role.ROLE_USER ||
				!text
			) {
				throw new Error("Invalid owner task");
			}
			const metadata = { "tvin.owner_scope": { tenant: config.tenant, ownerId } };
			const task: Task = {
				id: context.taskId,
				contextId: context.contextId,
				status: {
					state: TaskState.TASK_STATE_WORKING,
					message: undefined,
					timestamp: new Date().toISOString(),
				},
				history: [context.userMessage],
				artifacts: [],
				metadata,
			};
			events.publish(AgentEvent.task(task));
			events.publish(
				AgentEvent.statusUpdate({
					taskId: context.taskId,
					contextId: context.contextId,
					status: {
						state: TaskState.TASK_STATE_WORKING,
						message: undefined,
						timestamp: new Date().toISOString(),
					},
					metadata,
				}),
			);
			const response = await config.backend.run({ ownerId, text });
			events.publish(
				AgentEvent.artifactUpdate({
					taskId: context.taskId,
					contextId: context.contextId,
					append: false,
					lastChunk: true,
					metadata,
					artifact: {
						artifactId: context.taskId,
						name: "response",
						description: "Viktor response",
						parts: [
							{
								content: { $case: "text", value: response },
								metadata: undefined,
								filename: "",
								mediaType: "text/plain",
							},
						],
						metadata,
						extensions: [],
					},
				}),
			);
			events.publish(
				AgentEvent.statusUpdate({
					taskId: context.taskId,
					contextId: context.contextId,
					status: {
						state: TaskState.TASK_STATE_COMPLETED,
						message: undefined,
						timestamp: new Date().toISOString(),
					},
					metadata,
				}),
			);
		},
		cancelTask: async (taskId, events) => {
			events.publish(
				AgentEvent.statusUpdate({
					taskId,
					contextId: "",
					status: {
						state: TaskState.TASK_STATE_CANCELED,
						message: undefined,
						timestamp: new Date().toISOString(),
					},
					metadata: undefined,
				}),
			);
		},
	};
}

export function createViktorA2ASdkApp(config: ViktorA2ASdkConfig): {
	fetch: (request: Request) => Promise<Response>;
} {
	if (
		new URL(config.url).protocol !== "https:" ||
		config.publicKey.asymmetricKeyType !== "ed25519"
	) {
		throw new Error("Invalid Viktor A2A configuration");
	}
	const handler = new DefaultRequestHandler(
		createAgentCard(config.url, config.tenant),
		new InMemoryTaskStore(),
		createExecutor(config),
	);
	const transport = new JsonRpcTransportHandler(handler);
	const legacyTransport = new LegacyJsonRpcTransportHandler(handler);
	const responses = new Map<string, unknown>();
	return {
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
				return Response.json(await handler.getAgentCard());
			}
			if (request.method !== "POST" || url.pathname !== new URL(config.url).pathname)
				return Response.json({ error: "Not found" }, { status: 404 });
			const ownerId = verifyOwner(request.headers.get("authorization"), config);
			if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
			let body: Record<string, unknown>;
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return Response.json({ error: "Invalid JSON" }, { status: 400 });
			}
			const message = (
				body.params as
					| { message?: { metadata?: Record<string, unknown>; messageId?: string } }
					| undefined
			)?.message;
			const scope = message?.metadata?.["tvin.owner_scope"] as Record<string, unknown> | undefined;
			if (scope && (scope.tenant !== config.tenant || scope.ownerId !== ownerId))
				return Response.json({ error: "Forbidden" }, { status: 403 });
			const key = typeof message?.messageId === "string" ? `${ownerId}:${message.messageId}` : null;
			if (key && responses.has(key)) return Response.json(responses.get(key));
			const context = new ServerCallContext({
				tenant: config.tenant,
				requestedVersion: "1.0",
				state: new Map([["ownerId", ownerId]]),
			});
			const result =
				body.method === "message/send" ||
				body.method === "message/stream" ||
				body.method === "tasks/get"
					? await legacyTransport.handle(body, context)
					: await transport.handle(body, context);
			const response =
				result instanceof Object && Symbol.asyncIterator in result
					? await (async () => {
							let last: unknown;
							for await (const item of result) last = item;
							return last;
						})()
					: result;
			if (key) responses.set(key, response);
			return Response.json(response);
		},
	};
}

export { createPublicKey };
