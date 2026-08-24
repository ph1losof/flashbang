/**
 * Eager wiring of the per-language edition table.
 *
 * Runtimes that hold the whole catalog anyway — the service worker, the rich
 * page fallback, the settings UI, tests — import this once and never think
 * about the table again. The cold first-redirect path is the sole exception:
 * it imports `locale-table` dynamically and installs it itself, so that module
 * stays free of runtime imports and its chunk stays a single standalone file.
 */

import { localeChain, localeSplitOf, resolveLocaleValue } from "./locale-table";
import { installLocaleTable } from "./locale-tag";

installLocaleTable({ localeChain, localeSplitOf, resolveLocaleValue });
