// vite-env.d.ts

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_OPENAI_API_KEY?: string;

  // ── Amazon Bedrock / Nova ──────────────────────────────────────────────────
  /** AWS IAM Access Key ID (e.g. AKIAXXXXXXXXXXXXXXXX) */
  readonly VITE_AWS_ACCESS_KEY?: string;
  /** AWS IAM Secret Access Key */
  readonly VITE_AWS_SECRET_KEY?: string;
  /** AWS region where Bedrock is enabled (e.g. us-east-1) */
  readonly VITE_AWS_REGION?: string;
  /**
   * Bedrock API key — alternative to IAM credentials.
   * Create one in the Bedrock console under "API keys".
   * When set, SigV4 signing is skipped and this key is sent as x-api-key.
   */
  readonly VITE_AWS_BEDROCK_API_KEY?: string;
  /**
   * Bedrock model ID to use (default: amazon.nova-lite-v2:0).
   * Example: amazon.nova-lite-v2:0 or amazon.nova-pro-v1:0
   */
  readonly VITE_AWS_NOVA_MODEL?: string;
  /**
   * @deprecated Use the individual vars above instead.
   * Legacy colon-separated format: "accessKey:secretKey[:region[:model]]"
   */
  readonly VITE_AWS_BEDROCK_CREDENTIALS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
