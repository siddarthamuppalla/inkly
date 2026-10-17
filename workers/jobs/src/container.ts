import { Container } from "@cloudflare/containers";

/** The pdf-engine Container: containers/pdf-engine's HTTP service, one Durable Object per instance. */
export class PdfEngine extends Container {
  override defaultPort = 8080;
  override sleepAfter = "5m";
  // The engine only reads the request body; it never needs the internet.
  override enableInternet = false;
  // Waits for the engine's own health route instead of the default `/ping`.
  override pingEndpoint = "container/health";
}
