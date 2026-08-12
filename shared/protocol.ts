import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const BaseEnvelopeSchema = z.object({
  version: z.number(),
  session: z.string(),
  from: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  event: z.string(),
});

export type BaseEnvelope = z.infer<typeof BaseEnvelopeSchema>;

export function makeEnvelope(
  overrides: Partial<Omit<BaseEnvelope, "version">> &
    Pick<BaseEnvelope, "event">,
): BaseEnvelope {
  return {
    version: PROTOCOL_VERSION,
    session: "",
    from: "",
    seq: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function parseEnvelope(data: unknown): BaseEnvelope | null {
  const result = BaseEnvelopeSchema.safeParse(data);
  return result.success ? result.data : null;
}
