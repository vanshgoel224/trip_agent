import { z } from "zod";

// Stable Biruni tool contracts. The model and agents see these, never raw vendor APIs.
//
// PROVISIONAL NAMES: the design artifact fixes the count (7) but its text does
// not enumerate canonical tool names (spec §6, §32). These names are working
// placeholders — lock them against the final architecture diagram before
// implementation freeze. Renaming is a one-line change per tool.

const tripRef = { tripId: z.string().min(1), incidentId: z.string().optional() };
const rung = z.enum(["PINE_LABS_MERCHANT", "UPI_OPERATOR", "LOCAL_TRANSPORT", "LOGGED_CASH"]);

export const RouteSchema = z.object({
  routeId: z.string(),
  from: z.string(),
  to: z.string(),
  mode: z.enum(["BUS", "TRAIN", "FLIGHT", "CAB", "AUTO", "OTHER"]),
  departure: z.string(),
  arrival: z.string().optional(),
  vendorId: z.string(),
  vendorName: z.string(),
  vendorRung: rung,
  price: z.number().int().nonnegative(),
  source: z.enum(["LIVE", "OFFLINE_CACHE"]),
});

export const schemas = {
  voice_speak: z.object({
    ...tripRef,
    text: z.string().min(1).max(1000),
    language: z.string().default("en-IN"),
    to: z.enum(["TRAVELLER", "EMERGENCY_CONTACT"]).default("TRAVELLER"),
  }),
  route_search: z.object({
    ...tripRef,
    from: z.string().min(1),
    to: z.string().min(1),
    offline: z.boolean().default(false),
  }),
  vendor_verify: z.object({
    ...tripRef,
    incidentId: z.string(),
    vendorId: z.string(),
    quotedPrice: z.number().int().nonnegative(),
    referenceFare: z.number().int().nonnegative(),
  }),
  payment_execute: z.discriminatedUnion("operation", [
    z.object({
      ...tripRef,
      incidentId: z.string(),
      operation: z.literal("charge"),
      amount: z.number().int().positive(),
      vendorId: z.string(),
      rung,
      idempotencyKey: z.string().min(1),
    }),
    z.object({
      ...tripRef,
      incidentId: z.string(),
      operation: z.literal("refund"),
      paymentId: z.string(),
      idempotencyKey: z.string().min(1),
    }),
    z.object({ ...tripRef, incidentId: z.string(), operation: z.literal("status"), paymentId: z.string() }),
  ]),
  booking_execute: z.discriminatedUnion("operation", [
    z.object({
      ...tripRef,
      operation: z.literal("book"),
      route: RouteSchema,
      paymentId: z.string(),
      idempotencyKey: z.string().min(1),
    }),
    z.object({ ...tripRef, operation: z.literal("cancel"), bookingId: z.string(), idempotencyKey: z.string().min(1) }),
    z.object({ ...tripRef, operation: z.literal("verify"), bookingId: z.string() }),
  ]),
  financial_context: z.object({ ...tripRef, months: z.number().int().min(1).max(12).default(6) }),
  holdings_context: z.object({ ...tripRef }),

  // ---- Supporting tools (outside the spec's seven rail tools) ----
  discovery_search: z.object({ ...tripRef, place: z.string().min(2).max(80), sources: z.array(z.enum(["reddit", "youtube"])).default(["reddit", "youtube"]) }),
  calendar_read: z.object({ ...tripRef, days: z.number().int().min(1).max(60).default(14) }),
  calendar_write: z.object({
    ...tripRef,
    title: z.string().min(1).max(200),
    start: z.string().min(10),
    end: z.string().optional(),
    location: z.string().max(200).optional(),
  }),
};

export type ToolName = keyof typeof schemas;
export type ToolArgs<N extends ToolName> = z.infer<(typeof schemas)[N]>;
export const TOOL_NAMES = Object.keys(schemas) as ToolName[];
