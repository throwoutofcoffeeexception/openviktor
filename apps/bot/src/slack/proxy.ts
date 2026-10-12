import { HttpsProxyAgent } from "https-proxy-agent";

export function slackProxyAgent(): HttpsProxyAgent<string> | undefined {
	const url = process.env.HTTPS_PROXY ?? process.env.https_proxy;
	return url ? new HttpsProxyAgent(url) : undefined;
}
