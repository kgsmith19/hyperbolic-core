/// <reference types="vite/client" />

// Build-time constants injected by vite.config.ts's `define` block.
declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_ACC_API?: string;
  readonly VITE_LIFEOS_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
