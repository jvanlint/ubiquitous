import streamDeck from "@elgato/streamdeck";

import { LiveThroughput } from "./actions/live-throughput";
import { DeviceMetrics } from "./actions/device-metrics";
import { ClientMetrics } from "./actions/client-metrics";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new LiveThroughput());
streamDeck.actions.registerAction(new DeviceMetrics());
streamDeck.actions.registerAction(new ClientMetrics());

// Finally, connect to the Stream Deck.
streamDeck.connect();
