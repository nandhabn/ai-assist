// vite-env.d.ts

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_OPENAI_API_KEY?: string;
  /** AWS credentials for Amazon Nova — format: "accessKey:secretKey" or "accessKey:secretKey:region:model" */
  readonly VITE_AWS_BEDROCK_CREDENTIALS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
