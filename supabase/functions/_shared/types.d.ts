// Minimal ambient declarations so the functions typecheck in a plain Node/TS
// editor. The Deno runtime supplies the real definitions at deploy time.

declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
  };

  function serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
}

declare module "jsr:@supabase/supabase-js@2" {
  export function createClient(
    url: string,
    key: string,
    options?: unknown,
  ): any;
}
