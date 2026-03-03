// src/utils/novaProvider.ts

import {
  AIProvider,
  CompactContext,
  AIPrediction,
  FormFieldInfo,
  AIFormData,
} from "../types/ai";
import {
  PREDICTION_SYSTEM_PROMPT,
  FORM_DATA_SYSTEM_PROMPT,
  buildPredictionPrompt,
  buildFormDataPrompt,
  formatFieldDescriptions,
} from "@/config/prompts";

function aiLog(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  console.log(`[AI Call Log] [${ts}] ${msg}`);
}

// ─── AWS Signature V4 (lightweight, Web Crypto) ──────────────────────────────

const SERVICE = "bedrock";

async function hmacSHA256(
  key: ArrayBuffer,
  message: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function sha256(data: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return hexEncode(hash);
}

function hexEncode(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSHA256(
    new TextEncoder().encode("AWS4" + secretKey).buffer as ArrayBuffer,
    dateStamp,
  );
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, SERVICE);
  return hmacSHA256(kService, "aws4_request");
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

/**
 * Signs an AWS request using Signature Version 4 (Web Crypto API).
 * Returns the headers needed for authentication.
 */
async function signRequest(
  method: string,
  host: string,
  path: string,
  body: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken?: string,
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = getAmzDate();
  const payloadHash = await sha256(body);

  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    (sessionToken ? `x-amz-security-token:${sessionToken}\n` : "");

  const signedHeadersList = sessionToken
    ? "content-type;host;x-amz-date;x-amz-security-token"
    : "content-type;host;x-amz-date";

  const canonicalRequest = [
    method,
    path,
    "", // query string (empty)
    canonicalHeaders,
    signedHeadersList,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join("\n");

  const signingKey = await getSignatureKey(secretKey, dateStamp, region);
  const signatureBuffer = await hmacSHA256(signingKey, stringToSign);
  const signature = hexEncode(signatureBuffer);

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
    Authorization: authHeader,
  };
  if (sessionToken) {
    headers["X-Amz-Security-Token"] = sessionToken;
  }
  return headers;
}

// ─── Nova Provider ───────────────────────────────────────────────────────────

export interface NovaConfig {
  /** AWS IAM Access Key ID */
  accessKey: string;
  /** AWS IAM Secret Access Key */
  secretKey: string;
  /** AWS region, e.g. us-east-1 (default) */
  region?: string;
  /** Bedrock model ID (default: amazon.nova-lite-v1:0) */
  model?: string;
  /** AWS STS session token (only needed for temporary/assumed-role credentials) */
  sessionToken?: string;
  /**
   * Bedrock API key — alternative to IAM credentials.
   * When provided, SigV4 signing is skipped and this key is sent as x-api-key.
   * Create one in the AWS Bedrock console under "API keys".
   */
  bedrockApiKey?: string;
}

/**
 * An AIProvider implementation that uses Amazon Nova Lite via AWS Bedrock.
 *
 * Supports two auth modes:
 *   1. IAM credentials (accessKey + secretKey) with SigV4 signing
 *   2. Bedrock API key (bedrockApiKey) — simpler, no signing needed
 *
 * The Bedrock fetch is always proxied through the background worker to bypass CORS.
 */
export class NovaProvider implements AIProvider {
  private cfg: Required<Omit<NovaConfig, 'sessionToken' | 'bedrockApiKey'>> &
    Pick<NovaConfig, 'sessionToken' | 'bedrockApiKey'>;

  constructor(config: NovaConfig) {
    if (!config.accessKey || !config.secretKey) {
      throw new Error("NovaProvider requires at least accessKey and secretKey.");
    }
    this.cfg = {
      accessKey:    config.accessKey,
      secretKey:    config.secretKey,
      region:       config.region       || "us-east-1",
      model:        config.model        || "amazon.nova-lite-v2:0",
      sessionToken: config.sessionToken,
      bedrockApiKey: config.bedrockApiKey,
    };
    const authMode = this.cfg.bedrockApiKey ? "Bedrock API key" : "SigV4 (IAM)";
    aiLog(
      `[Nova] Initialized | AccessKey: ${this.cfg.accessKey.slice(0, 4)}**** | Region: ${this.cfg.region} | Model: ${this.cfg.model} | Auth: ${authMode}`,
    );
  }

  private get host(): string {
    return `bedrock-runtime.${this.cfg.region}.amazonaws.com`;
  }

  private get converseEndpoint(): string {
    return `https://${this.host}/model/${encodeURIComponent(this.cfg.model)}/converse`;
  }

  private get conversePath(): string {
    return `/model/${encodeURIComponent(this.cfg.model)}/converse`;
  }

  /**
   * Calls the Bedrock Converse API via the background worker to bypass CORS.
   * SigV4 signing is done here in the content script; only the fetch is proxied.
   */
  private async converse(
    systemPrompt: string,
    userMessage: string,
    temperature: number,
  ): Promise<string> {
    const body = JSON.stringify({
      system: [{ text: systemPrompt }],
      messages: [
        {
          role: "user",
          content: [{ text: userMessage }],
        },
      ],
      inferenceConfig: {
        temperature,
        maxTokens: 2048,
      },
    });

    let headers: Record<string, string>;
    if (this.cfg.bedrockApiKey) {
      // Bedrock API key auth — Bearer token, no SigV4 needed
      headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.cfg.bedrockApiKey}`,
      };
    } else {
      // IAM credentials — sign with SigV4
      headers = await signRequest(
        "POST",
        this.host,
        this.conversePath,
        body,
        this.cfg.region,
        this.cfg.accessKey,
        this.cfg.secretKey,
        this.cfg.sessionToken,
      );
    }

    // Route the actual fetch through the background worker to avoid CORS blocks.
    // Bedrock does not send Access-Control-Allow-Origin headers, so a direct
    // content-script fetch would be rejected by the browser.
    const result = await new Promise<{ ok: boolean; body?: string; status?: number; error?: string }>(
      (resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "NOVA_CONVERSE", url: this.converseEndpoint, headers, body },
          (resp) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            resolve(resp);
          },
        );
      },
    );

    if (!result.ok) {
      throw new Error(`Bedrock API error ${result.status ?? ""}: ${result.body ?? result.error}`);
    }

    const data = JSON.parse(result.body!);
    const text = data?.output?.message?.content?.[0]?.text;
    if (!text) {
      throw new Error("No text in Bedrock Converse response.");
    }
    return text;
  }

  /**
   * Extracts JSON from a response that may be wrapped in markdown fences.
   */
  private extractJson(content: string): string {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error("No JSON object found in Nova response.");
    }
    return content.substring(start, end + 1);
  }

  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    aiLog(
      `[Nova] predictNextAction START | Model: ${this.cfg.model} | Intent: ${context.pageIntent}`,
    );

    const prompt = buildPredictionPrompt(context);

    try {
      const raw = await this.converse(
        PREDICTION_SYSTEM_PROMPT,
        prompt,
        0.2,
      );
      const prediction = JSON.parse(this.extractJson(raw)) as AIPrediction;

      if (
        !prediction.predictedActionLabel ||
        !prediction.reasoning ||
        typeof prediction.confidenceEstimate !== "number"
      ) {
        throw new Error("Invalid prediction structure from Nova.");
      }

      aiLog(
        `[Nova] predictNextAction SUCCESS | Predicted: "${prediction.predictedActionLabel}" | Confidence: ${prediction.confidenceEstimate}`,
      );
      return prediction;
    } catch (error) {
      aiLog(`[Nova] predictNextAction ERROR | ${error}`);
      console.error("Error in NovaProvider:", error);
      throw new Error("Failed to get prediction from Amazon Nova.");
    }
  }

  async generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    aiLog(
      `[Nova] generateFormData START | Model: ${this.cfg.model} | Fields: ${fields.length} | Context: ${pageContext || "none"}`,
    );

    const fieldDescriptions = formatFieldDescriptions(fields);
    const prompt = buildFormDataPrompt(fieldDescriptions, pageContext);

    try {
      const raw = await this.converse(
        FORM_DATA_SYSTEM_PROMPT,
        prompt,
        0.7,
      );
      const parsed = JSON.parse(this.extractJson(raw)) as AIFormData;

      if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
        throw new Error("Invalid form data structure from Nova.");
      }

      aiLog(
        `[Nova] generateFormData SUCCESS | Keys: ${Object.keys(parsed.fieldValues).join(", ")}`,
      );
      return parsed;
    } catch (error) {
      aiLog(`[Nova] generateFormData ERROR | ${error}`);
      console.error("Error generating form data with Nova:", error);
      throw new Error("Failed to generate form data from Amazon Nova.");
    }
  }
}
