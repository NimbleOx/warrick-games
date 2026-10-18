// Just enough of the Workers runtime's "cloudflare:workers" module to run a Room in Node.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
