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
