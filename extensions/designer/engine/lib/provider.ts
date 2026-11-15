/**
 * Identity strings the engine's artifacts refer to. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Upstream retargets these per provider at build time. pi has one provider, so they are
 * constants — but the command string is the front door, and it says `designer` here, not
 * upstream's name, because `/impeccable` does not exist in pi.
 */

/** Prefix for command references inside generated guidance. */
const IMPECCABLE_COMMAND_PREFIX = "/";

/** The provider id the artifacts are written for. */
const IMPECCABLE_PROVIDER_ID = "pi";

/** The command a reader is told to run. */
const IMPECCABLE_COMMAND = `${IMPECCABLE_COMMAND_PREFIX}designer`;

export { IMPECCABLE_COMMAND, IMPECCABLE_COMMAND_PREFIX, IMPECCABLE_PROVIDER_ID };
