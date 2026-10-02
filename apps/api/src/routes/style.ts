// Routes: "My style" (vocabulary and way of talking) and the voice sample.
import type { RouteFn } from "../http";
import { rt } from "../spaces";

export default function register(route: RouteFn) {
  route("GET", "/api/style", () => ({ style: rt().style.get(), voice: rt().style.voiceStatus() }));
  route("POST", "/api/style", (_r, body) => ({ style: rt().style.save(body), voice: rt().style.voiceStatus() }));
  route("POST", "/api/style/voice", (_r, body) => rt().style.saveVoice(body));
  route("POST", "/api/style/voice/delete", () => rt().style.deleteVoice());
}
