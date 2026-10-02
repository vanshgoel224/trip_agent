import { config } from "../../packages/shared";
import { DelhiveryProvider, MockBookingProvider, MockRoutingProvider, type BookingProvider, type RoutingProvider } from "./delhivery";
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

export function createProviders(mode = config.providerMode): Providers {
  if (mode === "live") {
    return {
      voice: new GnaniProvider(),
      payments: new PineLabsProvider(),
      routing: new DelhiveryProvider(),
      booking: new MockBookingProvider(), // no booking rail named in the design artifact
      financial: new SetuProvider(),
      holdings: new ZerodhaProvider(),
    };
  }
  return {
    voice: new MockGnaniProvider(),
    payments: new MockPaymentProvider(),
    routing: new MockRoutingProvider(),
    booking: new MockBookingProvider(),
    financial: new MockSetuProvider(),
    holdings: new MockZerodhaProvider(),
  };
}
