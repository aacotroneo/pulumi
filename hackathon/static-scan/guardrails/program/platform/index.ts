// @acme/platform: the components app teams build with. Each one bakes in the company's defaults (encryption,
// versioning, private networking, tags), so app code says what it needs, not how to secure it.
export * as db from "./db";
export * as identity from "./identity";
export * as network from "./network";
export { provider } from "./provider";
export * as storage from "./storage";
