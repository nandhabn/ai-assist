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

/**
 * An AIProvider implementation that uses Amazon Nova Lite via AWS Bedrock.
 *
 * Uses the Bedrock Runtime Converse API (`/model/{modelId}/converse`)
 * for a clean request/response interface with system + user messages.
 *
 * @Security-Note AWS credentials (access key, secret key, optional session token)
 * are sensitive. They should be stored in `chrome.storage.local`, provided
 * through an options page, or ideally use temporary credentials from a backend.
 */
export class NovaProvider implements AIProvider {
  private accessKey: string;
  private secretKey: string;
  private region: string;
  private model: string;
  private sessionToken?: string;

  /**
   * @param credentials Colon-separated string: "accessKey:secretKey" or
   *   "accessKey:secretKey:sessionToken". Region and model can optionally
   *   be appended: "accessKey:secretKey:region:model".
   */
  constructor(credentials: string) {
    if (!credentials) {
      throw new Error("NovaProvider requires AWS credentials.");
    }
    const parts = credentials.split(":");

    if (parts.length < 2) {
      throw new Error(
        'NovaProvider credentials must be "accessKey:secretKey" or ' +
          '"accessKey:secretKey:sessionToken" or "accessKey:secretKey:region:model".',
      );
    }

    this.accessKey = parts[0];
    this.secretKey = parts[1];

    // Detect format: if third part looks like a region (contains a hyphen), treat as region
    if (parts.length >= 3 && parts[2].includes("-")) {
      this.region = parts[2];
      this.model = parts[3] || "amazon.nova-lite-v1:0";
    } else if (parts.length >= 3) {
      // Third part is a session token
      this.sessionToken = parts[2];
      this.region = parts[3] || "us-east-1";
      this.model = parts[4] || "amazon.nova-lite-v1:0";
    } else {
      this.region = "us-east-1";
      this.model = "amazon.nova-lite-v1:0";
    }
  }

  private get host(): string {
    return `bedrock-runtime.${this.region}.amazonaws.com`;
  }

  private get converseEndpoint(): string {
    return `https://${this.host}/model/${encodeURIComponent(this.model)}/converse`;
  }

  private get conversePath(): string {
    return `/model/${encodeURIComponent(this.model)}/converse`;
  }

  /**
   * Calls the Bedrock Converse API.
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

    const headers = await signRequest(
      "POST",
      this.host,
      this.conversePath,
      body,
      this.region,
      this.accessKey,
      this.secretKey,
      this.sessionToken,
    );

    const response = await fetch(this.converseEndpoint, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Bedrock API error ${response.status}: ${errorBody}`,
      );
    }

    const data = await response.json();
    // Converse API response shape:
    // { output: { message: { role: "assistant", content: [{ text: "..." }] } } }
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
      `[Nova] predictNextAction START | Model: ${this.model} | Intent: ${context.pageIntent}`,
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
      `[Nova] generateFormData START | Model: ${this.model} | Fields: ${fields.length} | Context: ${pageContext || "none"}`,
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
