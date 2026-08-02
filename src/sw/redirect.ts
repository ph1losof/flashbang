import {
  lookupAdvancedBang,
  lookupSnapOverride,
} from "../generated/bangs-sparse.js";
import { configureRedirectExtensions } from "./redirect-core";

configureRedirectExtensions(lookupAdvancedBang, lookupSnapOverride);

// biome-ignore lint/performance/noBarrelFile: compatibility facade installs the generated advanced lookup extension.
export * from "./redirect-core";
