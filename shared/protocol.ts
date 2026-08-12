import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const BaseEnvelopeSchema = z.object({
  version: z.number(),
  sessionId: z.string(),
  peerId: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  event: z.string(),
  payload: z.unknown().optional(),
});

export type BaseEnvelope = z.infer<typeof BaseEnvelopeSchema>;

export function makeEnvelope(
  overrides: Partial<Omit<BaseEnvelope, "version">> &
    Pick<BaseEnvelope, "event">,
): BaseEnvelope {
  return {
    version: PROTOCOL_VERSION,
    sessionId: "",
    peerId: "",
    seq: 0,
    timestamp: Date.now(),
    payload: undefined,
    ...overrides,
  };
}

export function parseEnvelope(data: unknown): BaseEnvelope | null {
  const result = BaseEnvelopeSchema.safeParse(data);
  return result.success ? result.data : null;
}
