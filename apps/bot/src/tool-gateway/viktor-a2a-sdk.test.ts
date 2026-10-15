import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createViktorA2ASdkApp } from "./viktor-a2a-sdk.js";

const URL = "https://viktor.example.test/a2a";
const OWNER = "owner:tg:8405041969";
const TENANT = "alpha";

function jwt(privateKey: KeyObject, extra: Record<string, unknown> = {}) {
	const issuedAt = Math.floor(Date.now() / 1000);
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({ alg: "EdDSA", typ: "JWT" });
	const claims = encode({
		iss: "twin",
		sub: extra.sub ?? OWNER,
		aud: extra.aud ?? URL,
		iat: extra.iat ?? issuedAt,
		exp: extra.exp ?? issuedAt + 180,
		jti: extra.jti ?? `jti-${issuedAt}`,
	});
	const unsigned = `${header}.${claims}`;
	const signature = sign(null, Buffer.from(unsigned), privateKey).toString("base64url");
	return `${unsigned}.${signature}`;
}

function message(requestId = "route-1", text = "Прочитай доступные уроки рабочего пространства") {
	return {
		jsonrpc: "2.0",
		id: requestId,
		method: "message/send",
		params: {
			message: {
				kind: "message",
				role: "user",
				messageId: requestId,
				parts: [{ kind: "text", text }],
				metadata: { "tvin.owner_scope": { tenant: TENANT, ownerId: OWNER } },
			},
		},
	};
}

describe("Viktor official A2A SDK server", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const backend = {
		runs: 0,
		async run(task: { ownerId: string; text: string }) {
			this.runs += 1;
			return `owner=${task.ownerId} text=${task.text}`;
		},
	};
	const app = createViktorA2ASdkApp({
		url: URL,
		tenant: TENANT,
		ownerId: OWNER,
		publicKey,
		backend,
	});

	async function post(body: unknown, bearer?: string) {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (bearer) headers.authorization = `Bearer ${bearer}`;
		const response = await app.fetch(
			new Request(URL, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			}),
		);
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	}

	it("serves an official agent card at the well-known path", async () => {
		const response = await app.fetch(
			new Request("https://viktor.example.test/.well-known/agent-card.json"),
		);
		expect(response.status).toBe(200);
		const card = (await response.json()) as {
			name: string;
			supportedInterfaces: Array<{ url: string }>;
		};
		expect(card.name).toBe("Viktor");
		expect(card.supportedInterfaces[0].url).toBe(URL);
	});

	it("rejects anonymous and foreign owners before the backend runs", async () => {
		expect((await post(message())).status).toBe(401);
		expect((await post(message(), jwt(privateKey, { sub: "owner:tg:1" }))).status).toBe(401);
		expect(
			(await post(message(), jwt(privateKey, { aud: "https://other.example/a2a" }))).status,
		).toBe(401);
		expect(backend.runs).toBe(0);
	});

	it("completes an owner task once and returns the same artifact on tasks/get", async () => {
		const first = await post(message(), jwt(privateKey));
		expect(first.status).toBe(200);
		const task = (first.json.result ?? first.json) as {
			kind: string;
			id: string;
			status: { state: string };
			artifacts: Array<{ parts: Array<{ text: string }> }>;
			metadata: { "tvin.owner_scope": { tenant: string; ownerId: string } };
		};
		expect(task.kind).toBe("task");
		expect(task.status.state).toBe("completed");
		expect(task.metadata["tvin.owner_scope"]).toEqual({ tenant: TENANT, ownerId: OWNER });
		expect(task.artifacts[0].parts[0].text).toContain("owner=owner:tg:8405041969");
		const duplicate = await post(message(), jwt(privateKey, { jti: "second-token" }));
		expect(duplicate.status).toBe(200);
		expect((duplicate.json.result as { id: string }).id).toBe(task.id);
		expect(backend.runs).toBe(1);
		const readback = await post(
			{ jsonrpc: "2.0", id: "get-1", method: "tasks/get", params: { id: task.id } },
			jwt(privateKey, { jti: "get-token" }),
		);
		expect(readback.status).toBe(200);
		expect((readback.json.result as { id: string }).id).toBe(task.id);
	});
});
