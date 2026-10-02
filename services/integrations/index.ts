import { config } from "../../packages/shared";
import { MockBookingProvider, MockRoutingProvider, type BookingProvider, type RoutingProvider } from "./delhivery";
import { GnaniProvider, MockGnaniProvider, type VoiceProvider } from "./gnani";
import { MockPaymentProvider, PineLabsProvider, type PaymentProvider } from "./pine-labs";
import { MockSetuProvider, SetuProvider, type FinancialDataProvider } from "./setu-aa";
import { MockZerodhaProvider, ZerodhaProvider, type HoldingsProvider } from "./zerodha";

export type Providers = {
  voice: VoiceProvider;
  payments: PaymentProvider;
  routing: RoutingProvider;
  booking: BookingProvider;
  financial: FinancialDataProvider;
  holdings: HoldingsProvider;
};

/**
 * Per-rail selection. A rail goes live when its credentials are present
 * (or when PROVIDER_MODE=live forces every rail live). PROVIDER_MODE=mock
 * forces the simulator everywhere, e.g. for tests and the scripted demo.
 */
export function createProviders(mode = config.providerMode): Providers {
  const live = (envKey: string) => mode === "live" || (mode !== "mock" && !!process.env[envKey]);
  return {
    voice: live("GNANI_API_KEY") ? new GnaniProvider() : new MockGnaniProvider(),
    payments: live("PINELABS_API_KEY") ? new PineLabsProvider() : new MockPaymentProvider(),
    // Transport alternatives are simulated; maps/geocoding/routing use OpenStreetMap.
    routing: new MockRoutingProvider(),
    booking: new MockBookingProvider(), // no booking rail is named in the design artifact
    financial: live("SETU_API_KEY") ? new SetuProvider() : new MockSetuProvider(),
    holdings: live("ZERODHA_API_KEY") ? new ZerodhaProvider() : new MockZerodhaProvider(),
  };
}

export function providerStatus(p: Providers) {
  const name = (o: object) => o.constructor.name;
  return {
    gnani: name(p.voice), pineLabs: name(p.payments), transport: name(p.routing),
    setuAA: name(p.financial), zerodha: name(p.holdings), booking: name(p.booking),
  };
}
